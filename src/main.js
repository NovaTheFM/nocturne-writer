import { Database } from './core/db.js';
import { defaultSettings, seedDocs, seedFolders, seedLore } from './core/defaults.js';
import {
  applySmartPunctuationToHtml,
  blockText,
  buildSummary,
  cleanAnalysisResidue,
  countWords,
  debounce,
  docText,
  escapeHtml,
  hexToRgb,
  normalizeHtml,
  parseBlocksFromEditable,
  parseTimelineRank,
  stripAnalysisMarkup,
  textFromHtml,
  uid,
} from './core/utils.js';
import { encryptJson, decryptJson } from './core/crypto.js';
import { TYPO_LOOKUP, normalizeTypoToken } from './core/typos.js';
import { platformFiles } from './platform/file-adapter.js';
import { detectRuntime } from './platform/runtime.js';
import { CommandPalette } from './features/command-palette.js';
import { buildAiContext, serializeAiContextSafe } from './features/ai-context.js';
import { NocturneEditorBridge } from './editor/nocturne-editor.js';
import { aiIcon, iconSvg } from './ui/icons.js';
import Sortable from './vendor/sortablejs/sortable.complete.esm.js';

if (typeof window !== 'undefined' && !window.Sortable) {
  window.Sortable = Sortable;
}

const LIVE_PREFIX = 'nocturne-live-v3-';
const STORAGE_WARNINGS = [];
const REVIEW_MODES = new Set(['write', 'editor', 'finalization']);

function storageNotice(message) {
  STORAGE_WARNINGS.push(message);
}

function safeGetStorageItem(storage, key, fallback = '') {
  try {
    const value = storage?.getItem(key);
    return value === null || value === undefined ? fallback : value;
  } catch {
    storageNotice(`Не удалось прочитать ${key}. Использовано безопасное значение.`);
    return fallback;
  }
}

function safeSetStorageItem(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return true;
  } catch {
    storageNotice(`Не удалось записать ${key}. Изменения останутся в памяти до успешного сохранения.`);
    return false;
  }
}

function safeRemoveStorageItem(storage, key) {
  try {
    storage?.removeItem(key);
    return true;
  } catch {
    storageNotice(`Не удалось удалить временную запись ${key}.`);
    return false;
  }
}

function safeStorageKeys(storage) {
  try {
    return Object.keys(storage || {});
  } catch {
    storageNotice('Браузер заблокировал список localStorage/sessionStorage.');
    return [];
  }
}

function safeParseJson(value, fallback, label = 'JSON') {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    storageNotice(`Повреждена запись ${label}. Использовано безопасное значение.`);
    return fallback;
  }
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function defaultDeviceName(runtime) {
  if (runtime?.isElectron) return 'Nocturne Desktop';
  if (runtime?.isAndroid) return 'Nocturne Android';
  return 'Nocturne Browser';
}

class LocalSyncClient {
  constructor(app) {
    this.app = app;
    this.ws = null;
  }

  isOpen() {
    return this.ws && this.ws.readyState === 1;
  }

  async connect({ host, port, token, trusted }) {
    if (this.isOpen()) this.ws.close();
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${host}:${port}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      let resolved = false;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'pair',
          protocolVersion: 1,
          token,
          deviceId: this.app.state.sync.deviceId,
          deviceName: this.app.state.sync.deviceName || 'Browser',
          deviceType: 'browser',
          runtime: 'browser',
        }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'paired') {
            resolved = true;
            this.app.state.sync.status = 'connected';
            this.app.state.sync.statusDetail = 'Подключено.';
            this.app.renderSyncStatus?.();
            resolve();
          } else if (message.type === 'error') {
            this.app.toast(message.message || 'Ошибка синхронизации.');
            if (!resolved) reject(new Error(message.message));
          } else {
            this.handleMessage(message);
          }
        } catch (e) {
          console.error('[sync client] error handling message:', e);
        }
      };

      ws.onerror = (err) => {
        if (!resolved) reject(err);
      };

      ws.onclose = () => {
        this.app.state.sync.status = 'disconnected';
        this.app.state.sync.statusDetail = 'Соединение закрыто.';
        this.app.renderSyncStatus?.();
      };
    });
  }

  send(message) {
    if (this.isOpen()) {
      this.ws.send(JSON.stringify(message));
    }
  }

  handleMessage(message) {
    if (message.type === 'project-state-request') {
      this.app.sendSyncProjectState();
    } else if (message.type === 'project-state') {
      this.app.receiveSyncProjectState(message);
    } else if (message.type === 'merge-accepted') {
      this.app.receiveSyncMergeAccepted(message);
    } else if (message.type === 'doc-patch') {
      this.app.receiveSyncPatch(message.patch);
    }
  }
}

class NocturneWriter {
  constructor() {
    this.db = new Database();
    this.runtime = detectRuntime();
    this.isComposing = false;
    const reviewMode = safeGetStorageItem(localStorage, 'nocturne-review-mode', 'write');
    this.state = {
      settings: { ...defaultSettings },
      folders: [],
      docs: [],
      lore: { characters: [], locations: [], timeline: [], notes: [] },
      activeDocId: null,
      workspace: null,
      sync: {
        deviceId: safeGetStorageItem(localStorage, 'nocturne-sync-device-id', uid('device')),
        deviceName: safeGetStorageItem(localStorage, 'nocturne-sync-device-name', ''),
        discoveredDevices: [],
        rememberedDevices: [],
        host: safeGetStorageItem(localStorage, 'nocturne-sync-host', ''),
        port: safeGetStorageItem(localStorage, 'nocturne-sync-port', '8787'),
        token: safeGetStorageItem(localStorage, 'nocturne-sync-token', ''),
        discovery: { manualOpen: false },
        status: 'disconnected',
        statusDetail: '',
        remoteState: null,
        mergePreview: null,
        pendingPatches: 0,
        conflicts: 0,
      },
      pageStates: {},
      activeKbTab: 'characters',
      activeSubtimelineId: null,
      activeLoreDetail: null,
      activeSettingsTab: 'visual',
      pages: [],
            zenActive: false,
      suggestion: null,
      noteMode: 'document',
      globalNotes: safeGetStorageItem(localStorage, 'nocturne-global-notes', ''),
      floatingNotes: [],
      floatingNotesShowAll: false,
      floatingNotesManagerOpen: false,
      typoRules: [],
      reviewMarks: [],
      reviewMode: REVIEW_MODES.has(reviewMode) ? reviewMode : 'write',
      contextMenu: null,
      dictionaryFilter: 'all',
      dictionarySearch: '',
      currentReviewIndexByDoc: {},
      activeReviewMarkId: null,
      saveStatusByDoc: {},
      exportNocturned: safeGetStorageItem(localStorage, 'nocturne-export-nocturned', 'true') !== 'false',
      collapsedFolders: safeParseJson(safeGetStorageItem(localStorage, 'nocturne-collapsed-folders', '[]'), [], 'nocturne-collapsed-folders'),
      docSearch: '',
      kbSearch: '',
      sessionPassword: safeGetStorageItem(sessionStorage, 'nocturne-master-password', ''),
      mobile: {
        activeTab: 'write',
        previousTab: 'write',
        tabDirection: 0,
        panel: null,
        previousPanel: null,
        routeStack: [],
        panelMode: 'screen',
        keyboardOpen: false,
        editorFocused: false,
        settingsTab: null,
        kbTab: 'characters',
        docsSearch: '',
        loreSearch: '',
        notesMode: 'document',
        reorderMode: false,
        formatBarVisible: false,
        formatBarMode: 'hidden',
        systemTime: '',
        batteryLevel: null,
      },
      editorSelection: {
        active: false,
        text: '',
        docId: null,
        paneId: null,
      },
    };
    this.saveActiveDocDebounced = debounce(() => this.saveActiveDoc({ silent: true }), 450);
    this.repaginateDebounced = debounce(() => this.renderWorkspace(), 320);
    this.updateReadabilityDebounced = debounce(() => this.updateReadabilityHighlights(), 120);
    this.updateTypoHighlightsDebounced = debounce(() => this.updateTypoHighlights(), 150);
    this.liveEntityRefreshDebounced = debounce((editable) => this.refreshEntityLinksNearCaret(editable), 180);
    this.liveEntityRefreshSlowDebounced = debounce((editable) => this.refreshEntityLinksNearCaret(editable), 520);
    this.softEmptyLine = null;
    this.kbDragState = null;
    this.kbSortables = [];
    this.docSortables = [];
    this.pageObservers = {};
    this.saveDocDebouncers = new Map();
    this.saveFloatingNoteDebouncers = new Map();
    this.floatingNoteDrag = null;
    this.floatingNotesMenuHideTimer = null;
    this.floatingNotesMenuAnchorHovered = false;
    this.floatingNotesMenuHovered = false;
    this.contextSelectionRange = null;
    this.workspaceResize = null;
    this.kbSuppressClickUntil = 0;
    this.ctrlPressed = false;
    this.hoveredEntityLink = null;
    this.entityHoverHideTimer = null;
    this.entityAnchorHovered = false;
    this.entityPopupHovered = false;
    this.entityPreviewHovered = false;
    this.activeEntityHoverKey = '';
    this.aiSuggestionTimer = null;
    this.assistantTargetSnapshot = null;
    this.activeAiRequest = null;
    this.assistantState = 'idle';
    this.assistantBusyKind = '';
    this.assistantPanelMessage = '';
    this.splitMenuOpen = false;
    this.docPaneDropState = null;
    this.docDragSnapshot = null;
    this.activeFloatingMenuKey = '';
    this.floatingMenuCloseTimers = new Map();
    this.searchSession = null;
    this.replaceSession = null;
    this.syncPatchDebounced = debounce((docId, reason) => this.queueLiveSyncPatch(docId, reason), 500);
    this.globalSearchState = { query: '', caseSensitive: false, wholeWords: false, results: [], entitySuggestions: [] };
    this.searchRefreshDebounced = debounce(() => this.refreshSearchSession(), 180);
    this.selectionSnapshot = null;
    this.selectionController = {
      active: false,
      mode: 'native',
      range: null,
      docId: null,
      paneId: null,
      text: '',
      editable: null,
    };
    this.mobileSelectionTimer = null;
    this.mobileSelectionDrag = null;
    this.mobileFormatAction = null;
    this.nocturneSelectionLayer = null;
    this.reviewToolbarSelectionSnapshot = null;
        this.nocturnedImportQueue = [];
    this.nocturnedImportModalOpen = false;
    this.docWordBaselines = new Map();
    this.settingsTooltipTimer = null;
    this.settingsTooltipHideTimer = null;
    this.repaginateSettingsDebounced = debounce(() => this.renderWorkspace(), 260);
    this.typoMatchIndex = [];
    this.commandPalette = new CommandPalette(this);
    this.nocturneEditor = new NocturneEditorBridge({
      getSettings: () => this.state.settings,
      getMentionIndex: () => this.buildEntityMentionIndex(),
      onFocus: (paneId) => {
        if (this.state.workspace?.focusedPaneId !== paneId) this.setFocusedPane(paneId);
        this.handleMobileViewportChange();
      },
      onSelectionUpdate: () => {
        this.captureSelectionSnapshot();
        this.updateActiveBlock();
        this.updateEditorSelectionState();
        this.updateToolbarState();
      },
      onChange: ({ paneId, doc, transaction }) => this.handleRichEditorChange(paneId, doc, transaction),
    });
    this.syncClient = new LocalSyncClient(this);
                    this.lastAiContext = null;
    this.mobileResizeDebounced = debounce(() => this.handleMobileViewportChange(), 120);
      }

  async init() {
    const fill = document.querySelector('.preloader-progress-fill');
    if (fill) {
      fill.style.transition = 'width 1.2s cubic-bezier(0.22, 1, 0.36, 1)';
      fill.style.width = '70%';
    }
    this.clearLegacyStorage();
    await this.db.open();
    const settings = await this.db.get('settings', 'app');
    this.state.settings = this.validateSettings(settings?.value || {});
    this.injectCustomFonts();
    if (!document.getElementById('reaper-recolor-filter')) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      svg.style.pointerEvents = 'none';
      svg.innerHTML = `
        <filter id="reaper-recolor-filter">
          <feFlood flood-color="var(--accent)" result="flood" />
          <feComposite in="flood" in2="SourceAlpha" operator="atop" />
        </filter>
      `;
      document.body.appendChild(svg);
    }
    this.state.sessionPassword = safeGetStorageItem(sessionStorage, 'nocturne-master-password', '');
                if (!safeGetStorageItem(localStorage, 'nocturne-writing-animation-choice', '') && this.state.settings.writingAnimation === 'off') {
      this.state.settings.writingAnimation = defaultSettings.writingAnimation;
    }
    this.state.folders = this.validateFolders(await this.db.getAll('folders'));
    this.state.docs = await this.loadDocs();
    // Only calculate word baseline for active document on startup to avoid startup lag
    const activeDoc = this.state.docs.find((doc) => doc.id === this.state.activeDocId) || this.state.docs[0];
    if (activeDoc) {
      this.docWordBaselines.set(activeDoc.id, countWords(docText(activeDoc.ast)));
    }
    this.state.lore = await this.loadLore();
    await this.loadFloatingNotes();
    await this.loadTypoRules();
    await this.loadReviewMarks();
    await this.saveLore();
    this.validateLoadedState();
    this.initWorkspace();
    this.renderShell();
    this.showStorageWarnings();
    this.applySettings();
    this.renderAll();
    this.startPreloader();
    this.bindGlobalEvents();
    this.startMobileSystemBar();
    this.applyAndroidSystemBars();
    this.startGitAutosave();
  }

  startGitAutosave() {
    if (this.gitAutosaveInterval) {
      clearInterval(this.gitAutosaveInterval);
    }
    const minutes = Math.max(1, this.state.settings.autosaveMinutes || 3);
    this.gitAutosaveInterval = setInterval(async () => {
      if (!this.state.settings.gitVersioning) return;
      try {
        const dump = await this.buildNocturneDump();
        const data = JSON.stringify(dump, null, 2);
        const projectName = dump.projectTitle || 'nocturne-project';
        await platformFiles.saveGitSnapshot(data, projectName);
      } catch (err) {
        console.warn('Git autosave failed:', err);
      }
    }, minutes * 60000);
  }

  showStorageWarnings() {
    const unique = [...new Set(STORAGE_WARNINGS)].slice(0, 3);
    if (!unique.length) return;
    setTimeout(() => this.toast(unique.join(' '), 5200), 250);
  }

  validateSettings(raw = {}) {
    const source = isPlainObject(raw) ? raw : {};
    const merged = { ...defaultSettings, ...source };
    const clamp = (key, min, max, fallback = defaultSettings[key]) => {
      const value = Number(merged[key]);
      merged[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };
    const bools = ['windowMaterial', 'cursorGlow', 'compactPanels', 'experimentalDesign', 'caretBreath', 'paragraphIndent', 'smartPunctuation', 'writerSyntax', 'baselineGrid', 'readability', 'typewriterSound', 'typewriterMode', 'strictSpellcheck', 'smartDictionary', 'sentenceFocus', 'showDontTell', 'sentimentTimeline', 'sprintLock', 'timeMachine', 'gitVersioning', 'e2e', 'watermark', 'liveSave', 'autoPaginate', 'showPageRulers', 'showZenButton', 'notesAutosave', 'toolbarSticky', 'reduceMobileAnimations', 'aiKnowledgeContext', 'aiContextCharacters', 'aiContextLocations', 'aiContextTimeline', 'aiContextSubtimelines', 'aiContextRules', 'aiContextNotes'];
    bools.forEach((key) => { merged[key] = !!merged[key]; });
    const allowedFonts = ['Lora', 'Manrope', 'Georgia', 'Inter', 'Playfair Display', 'Merriweather', 'Courier New'];
    if (Array.isArray(merged.customFonts)) {
      merged.customFonts.forEach((f) => {
        if (f && f.name) allowedFonts.push(f.name);
      });
    }
    const enums = {
      theme: ['nocturne', 'midnight', 'paper', 'matrix', 'lavender', 'crimson'],
      caretStyle: ['line', 'block', 'underline'],
      fontFamily: allowedFonts,
      dialogueLens: ['off', 'dialogues', 'descriptions'],
      aiProvider: ['local', 'ollama', 'groq', 'gemini', 'openai', 'anthropic'],
      aiPersona: ['coauthor', 'muse', 'critic'],
      loreReaction: ['soft', 'warn', 'hard'],
      writingAnimation: ['off', 'ripple', 'mist', 'sparkles', 'glow', 'spark'],
    };
    Object.entries(enums).forEach(([key, allowed]) => {
      if (!allowed.includes(merged[key])) merged[key] = defaultSettings[key];
    });
    if (!/^#[0-9a-f]{6}$/iu.test(String(merged.accent || ''))) merged.accent = defaultSettings.accent;
    if (!Array.isArray(merged.macros)) {
      merged.macros = defaultSettings.macros || [];
    } else {
      merged.macros = merged.macros.filter((m) => m && typeof m.keys === 'string' && typeof m.value === 'string');
    }
    ['aiEndpoint', 'aiKey', 'aiModel', 'authorName'].forEach((key) => { merged[key] = String(merged[key] ?? defaultSettings[key] ?? ''); });
    clamp('caretBlink', 250, 1800);
    clamp('textContrast', 0, 100);
    clamp('fontSize', 12, 34);
    clamp('lineHeight', 1.15, 2.5);
    clamp('letterSpacing', 0, 2);
    clamp('paragraphSpacing', 0, 3);
    clamp('dailyGoal', 1, 50000);
        clamp('aiTemperature', 0, 2);
    clamp('loreStrictness', 0, 100);
    clamp('autosaveMinutes', 1, 120);
    return merged;
  }

  validateFolders(folders = []) {
    const clean = (Array.isArray(folders) ? folders : [])
      .filter(isPlainObject)
      .map((folder, index) => ({
        id: String(folder.id || uid('folder')),
        title: String(folder.title || 'Папка').slice(0, 80),
        order: Number.isFinite(Number(folder.order)) ? Number(folder.order) : index,
        createdAt: Number(folder.createdAt || Date.now()),
        updatedAt: Number(folder.updatedAt || Date.now()),
      }))
      .sort((a, b) => a.order - b.order);
    return clean.length ? clean : seedFolders.map((folder) => ({ ...folder }));
  }

  validateLoadedState() {
    this.state.collapsedFolders = Array.isArray(this.state.collapsedFolders) ? this.state.collapsedFolders.filter((id) => this.state.folders.some((folder) => folder.id === id)) : [];
    this.state.docs = (Array.isArray(this.state.docs) ? this.state.docs : []).filter((doc) => doc?.id);
    this.state.lore = {
      characters: Array.isArray(this.state.lore?.characters) ? this.state.lore.characters : [],
      locations: Array.isArray(this.state.lore?.locations) ? this.state.lore.locations : [],
      timeline: Array.isArray(this.state.lore?.timeline) ? this.state.lore.timeline : [],
      notes: Array.isArray(this.state.lore?.notes) ? this.state.lore.notes : [],
    };
    if (!this.state.docs.some((doc) => doc.id === this.state.activeDocId)) this.state.activeDocId = this.state.docs[0]?.id || null;
    if (this.state.activeSubtimelineId && !this.timelineEvent(this.state.activeSubtimelineId)) this.state.activeSubtimelineId = null;
  }

  clearLegacyStorage() {
    safeStorageKeys(localStorage).forEach((key) => {
      if (key.startsWith('nocturne-live-') && !key.startsWith(LIVE_PREFIX)) safeRemoveStorageItem(localStorage, key);
      if (key.startsWith(LIVE_PREFIX)) {
        const value = safeGetStorageItem(localStorage, key, '');
        if (/sentence-|senten[\p{L}-]*?(short|long)|[\p{Script=Cyrillic}a-z]{0,6}hort["»&>]/iu.test(value) || value.length > 750000) safeRemoveStorageItem(localStorage, key);
      }
    });
  }

  async loadDocs() {
    const docs = await this.db.getAll('docs');
    const password = this.state.sessionPassword;
    return Promise.all(docs.map(async (doc) => {
      if (!doc.encrypted) return doc;
      if (!password) return { ...doc, locked: true, ast: { type: 'doc', blocks: [{ id: uid('block'), type: 'paragraph', html: 'Документ зашифрован. Введите мастер-пароль в настройках данных.' }] } };
      try {
        const decoded = { ...doc, ...(await decryptJson(doc.encrypted, password)), encrypted: doc.encrypted };
        return { ...decoded, description: decoded.description || decoded.summary || 'Без описания' };
      } catch {
        return { ...doc, locked: true, ast: { type: 'doc', blocks: [{ id: uid('block'), type: 'paragraph', html: 'Не удалось расшифровать документ: неверный пароль.' }] } };
      }
    })).then((docs) => docs.map((doc) => this.sanitizeDoc(this.mergeLiveDraft({ ...doc, description: doc.description || doc.summary || 'Без описания' }))));
  }

  sanitizeDoc(doc) {
    const now = Date.now();
    doc.id = String(doc.id || uid('doc'));
    doc.folderId = this.state.folders.some((folder) => folder.id === doc.folderId) ? doc.folderId : this.defaultFolderId();
    doc.title = String(doc.title || 'Без названия');
    doc.description = String(doc.description || doc.summary || 'Без описания');
    doc.notes = String(doc.notes || '');
    doc.order = Number.isFinite(Number(doc.order)) ? Number(doc.order) : 0;
    doc.createdAt = Number(doc.createdAt || now);
    doc.updatedAt = Number(doc.updatedAt || now);
    
    doc.docType = ['document', 'book-chapter'].includes(doc.docType) ? doc.docType : 'document';
    if (doc.docType === 'book-chapter') {
      doc.workTitle = String(doc.workTitle || '');
      doc.volume = String(doc.volume || '');
      doc.chapterNumber = String(doc.chapterNumber || '');
      doc.bookStatus = ['Не редактировано', 'На редакции', 'Вычитка', 'Чистовая версия', 'Закончено'].includes(doc.bookStatus) ? doc.bookStatus : 'Не редактировано';
    }

    if (!isPlainObject(doc.ast)) doc.ast = { type: 'doc', blocks: [] };
    if (!Array.isArray(doc.ast.blocks)) doc.ast.blocks = [];
    doc.ast.blocks = doc.ast.blocks.map((block) => {
      let h = String(block.html || '');
      h = normalizeHtml(cleanAnalysisResidue(h));
      const type = ['paragraph', 'heading', 'quote'].includes(block.type) ? block.type : 'paragraph';
      const align = ['left', 'center', 'right', 'justify'].includes(block.align) ? block.align : 'left';
      return { ...block, id: String(block.id || uid('block')), type, align, html: h.trim() || '<br>' };
    });
    if (!doc.ast.blocks.length) doc.ast.blocks = [{ id: uid('block'), type: 'paragraph', align: 'left', html: '<br>' }];
    return doc;
  }

  async loadFloatingNotes() {
    const notes = await this.db.getAll('floatingNotes');
    this.state.floatingNotes = notes
      .map((note) => this.sanitizeFloatingNote(note))
      .sort((a, b) => (a.zIndex - b.zIndex) || (a.updatedAt - b.updatedAt));
  }

  async loadTypoRules() {
    const rules = await this.db.getAll('typoRules');
    this.state.typoRules = rules.map((rule) => this.sanitizeTypoRule(rule)).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  sanitizeTypoRule(rule = {}) {
    const wrong = String(rule.wrong || '').trim().replace(/\s+/g, ' ');
    const correct = String(rule.correct || '').trim();
    if (!wrong) return null;
    const normalizedWrong = normalizeTypoToken(rule.normalizedWrong || wrong);
    const source = ['user', 'override', 'disabled-builtin'].includes(rule.source) ? rule.source : 'user';
    const matchMode = rule.matchMode || (/\s/u.test(wrong) ? 'phrase' : 'token');
    const now = Date.now();
    return {
      id: rule.id || uid('typo-rule'),
      wrong,
      normalizedWrong,
      correct,
      label: String(rule.label || 'Мой словарь').trim(),
      enabled: rule.enabled !== false,
      source,
      matchMode: matchMode === 'phrase' ? 'phrase' : 'token',
      builtinKey: rule.builtinKey ? normalizeTypoToken(rule.builtinKey) : (source !== 'user' ? normalizedWrong : null),
      createdAt: rule.createdAt || now,
      updatedAt: rule.updatedAt || now,
    };
  }

  async saveTypoRule(rule) {
    const clean = this.sanitizeTypoRule({ ...rule, updatedAt: Date.now() });
    if (!clean) return null;
    const index = this.state.typoRules.findIndex((item) => item.id === clean.id);
    if (index >= 0) this.state.typoRules.splice(index, 1, clean);
    else this.state.typoRules.unshift(clean);
    await this.db.put('typoRules', clean);
    this.updateTypoHighlights();
    if (this.state.activeSettingsTab === 'dictionary') this.renderSettings();
    return clean;
  }

  async deleteTypoRule(id) {
    this.state.typoRules = this.state.typoRules.filter((rule) => rule.id !== id);
    await this.db.delete('typoRules', id);
    this.updateTypoHighlights();
    if (this.state.activeSettingsTab === 'dictionary') this.renderSettings();
  }

  async loadReviewMarks() {
    const marks = await this.db.getAll('reviewMarks');
    this.state.reviewMarks = marks.map((mark) => this.sanitizeReviewMark(mark)).filter(Boolean).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  sanitizeReviewMark(mark = {}) {
    if (!mark.docId || !mark.start || !mark.end) return null;
    const now = Date.now();
    const categories = ['orthography', 'punctuation', 'grammar', 'style', 'repetition', 'lore', 'continuity', 'logic', 'plot'];
    return {
      id: mark.id || uid('review'),
      docId: mark.docId,
      kind: ['comment', 'issue', 'suggestion'].includes(mark.kind) ? mark.kind : 'comment',
      category: categories.includes(mark.category) ? mark.category : 'style',
      colorKey: mark.colorKey || mark.category || 'style',
      quote: String(mark.quote || ''),
      prefix: String(mark.prefix || ''),
      suffix: String(mark.suffix || ''),
      start: mark.start,
      end: mark.end,
      comment: String(mark.comment || ''),
      suggestion: String(mark.suggestion || ''),
      source: mark.source === 'ai' ? 'ai' : mark.source || 'manual',
      severity: ['low', 'medium', 'high'].includes(mark.severity) ? mark.severity : '',
      status: ['open', 'resolved', 'accepted', 'rejected'].includes(mark.status) ? mark.status : 'open',
      unresolvedRange: !!mark.unresolvedRange,
      createdAt: mark.createdAt || now,
      updatedAt: mark.updatedAt || now,
    };
  }

  async saveReviewMark(mark) {
    const clean = this.sanitizeReviewMark({ ...mark, updatedAt: Date.now() });
    if (!clean) return null;
    const index = this.state.reviewMarks.findIndex((item) => item.id === clean.id);
    if (index >= 0) this.state.reviewMarks.splice(index, 1, clean);
    else this.state.reviewMarks.push(clean);
    await this.db.put('reviewMarks', clean);
    this.updateReviewHighlights();
    this.renderReviewNavigator();
    this.renderReviewToolbarSlot();
    return clean;
  }

  async deleteReviewMark(id) {
    this.state.reviewMarks = this.state.reviewMarks.filter((mark) => mark.id !== id);
    await this.db.delete('reviewMarks', id);
    this.updateReviewHighlights();
    this.renderReviewNavigator();
    this.renderReviewToolbarSlot();
  }

  sanitizeFloatingNote(note = {}) {
    const now = Date.now();
    const scope = ['global', 'document', 'character', 'location'].includes(note.scope) ? note.scope : 'global';
    return {
      id: note.id || uid('float-note'),
      title: String(note.title || 'Новая заметка').slice(0, 120),
      body: String(note.body || ''),
      scope,
      linkedId: note.linkedId || null,
      x: Number.isFinite(Number(note.x)) ? Number(note.x) : 420,
      y: Number.isFinite(Number(note.y)) ? Number(note.y) : 160,
      width: Number.isFinite(Number(note.width)) ? Math.max(240, Number(note.width)) : 320,
      height: Number.isFinite(Number(note.height)) ? Math.max(160, Number(note.height)) : 260,
      zIndex: Number.isFinite(Number(note.zIndex)) ? Number(note.zIndex) : 100,
      minimized: !!note.minimized,
      pinned: !!note.pinned,
      temporary: !!note.temporary,
      hidden: !!note.hidden,
      forceVisible: !!note.forceVisible,
      createdAt: note.createdAt || now,
      updatedAt: note.updatedAt || now,
    };
  }

  mergeLiveDraft(doc) {
    if (!this.state.settings.liveSave || this.state.settings.e2e || doc.locked) return doc;
    const draft = safeParseJson(safeGetStorageItem(localStorage, `${LIVE_PREFIX}${doc.id}`, 'null'), null, `${LIVE_PREFIX}${doc.id}`);
    if (draft?.updatedAt && draft.updatedAt > (doc.updatedAt || 0) && isPlainObject(draft.ast)) {
      return { ...doc, ast: draft.ast || doc.ast, notes: draft.notes ?? doc.notes, updatedAt: draft.updatedAt };
    }
    return doc;
  }

  async loadLore() {
    const lore = await this.db.get('lore', 'world');
    return {
      characters: (lore?.characters || []).map((item, index) => this.normalizeCharacter(item, index)),
      locations: (lore?.locations || []).map((item, index) => this.normalizeLocation(item, index)),
      timeline: (lore?.timeline || []).map((item, index) => this.normalizeTimelineEvent(item, index)),
      notes: (lore?.notes || []).map((item, index) => this.normalizeNote(item, index)),
    };
  }

  normalizeNote(item = {}, index = 0) {
    return {
      ...item,
      id: String(item.id || uid('note')),
      type: 'note',
      title: String(item.title || '').trim(),
      body: String(item.body || '').trim(),
      order: Number.isFinite(item.order) ? item.order : index,
    };
  }

  normalizeCharacter(item = {}, index = 0) {
    const parsed = this.splitCharacterName(item.displayName || item.name || '');
    const firstName = (item.firstName || parsed.firstName || '').trim();
    const lastName = (item.lastName || parsed.lastName || '').trim();
    const displayName = `${firstName} ${lastName}`.trim() || String(item.displayName || item.name || '').trim();
    return {
      ...item,
      id: item.id || uid('char'),
      type: 'character',
      firstName,
      lastName,
      displayName,
      name: displayName,
      role: item.role || '',
      body: item.body || '',
      icon: item.icon || 'bx-user',
      image: item.image || '',
      aliases: Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : [],
      mentionForms: Array.isArray(item.mentionForms) ? item.mentionForms.filter(Boolean) : [],
      documentIds: Array.isArray(item.documentIds) ? item.documentIds : [],
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    };
  }

  normalizeLocation(item = {}, index = 0) {
    const name = String(item.displayName || item.name || '').trim();
    return {
      ...item,
      id: item.id || uid('loc'),
      type: 'location',
      name,
      displayName: name,
      role: item.role || '',
      body: item.body || '',
      icon: item.icon || 'bx-buildings',
      image: item.image || '',
      aliases: Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : [],
      mentionForms: Array.isArray(item.mentionForms) ? item.mentionForms.filter(Boolean) : [],
      documentIds: Array.isArray(item.documentIds) ? item.documentIds : [],
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    };
  }

  normalizeTimelineEvent(item = {}, index = 0) {
    return {
      ...item,
      id: String(item.id || uid('time')),
      type: 'timeline',
      date: String(item.date || ''),
      title: String(item.title || 'Событие'),
      body: String(item.body || ''),
      documentIds: Array.isArray(item.documentIds) ? item.documentIds : [],
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      characterIds: Array.isArray(item.characterIds) ? item.characterIds : [],
      locationIds: Array.isArray(item.locationIds) ? item.locationIds : [],
      chapterIds: Array.isArray(item.chapterIds) ? item.chapterIds : [],
      noteIds: Array.isArray(item.noteIds) ? item.noteIds : [],
      characterRoles: (item.characterRoles && typeof item.characterRoles === 'object') ? item.characterRoles : {},
      subEvents: Array.isArray(item.subEvents)
        ? item.subEvents.map((event, eventIndex) => ({
          ...event,
          id: String(event.id || uid('subtime')),
          type: 'subtimeline',
          date: String(event.date || ''),
          title: String(event.title || 'Саб-событие'),
          body: String(event.body || ''),
          documentIds: Array.isArray(event.documentIds) ? event.documentIds : [],
          characterIds: Array.isArray(event.characterIds) ? event.characterIds : [],
          locationIds: Array.isArray(event.locationIds) ? event.locationIds : [],
          chapterIds: Array.isArray(event.chapterIds) ? event.chapterIds : [],
          noteIds: Array.isArray(event.noteIds) ? event.noteIds : [],
          characterRoles: (event.characterRoles && typeof event.characterRoles === 'object') ? event.characterRoles : {},
          order: Number.isFinite(Number(event.order)) ? Number(event.order) : eventIndex,
        }))
        : [],
    };
  }

  splitCharacterName(name = '') {
    const parts = String(name).trim().split(/\s+/u).filter(Boolean);
    if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  }

  get activeDoc() {
    return this.getFocusedDoc?.() || null;
  }

  emptyPaneDescriptor(id) {
    return { id, type: null, docId: null, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null };
  }

  normalizePaneDescriptor(raw = {}, id = 'primary', fallbackDocId = null) {
    const validDocId = (docId) => this.state.docs.some((doc) => doc.id === docId) ? docId : null;
    const type = raw.type || (raw.docId ? 'document' : null);
    if (type === 'document') {
      const docId = validDocId(raw.docId) || (raw.docId === undefined ? fallbackDocId : null);
      return docId ? { ...this.emptyPaneDescriptor(id), type: 'document', docId } : this.emptyPaneDescriptor(id);
    }
    if (type === 'kb-tab') return { ...this.emptyPaneDescriptor(id), type, kbTab: raw.kbTab || 'characters', subtimelineParentId: raw.subtimelineParentId || null };
    if (type === 'character-detail' || type === 'location-detail' || type === 'note-detail') return { ...this.emptyPaneDescriptor(id), type, entityType: raw.entityType || type.replace('-detail', ''), entityId: raw.entityId || null };
    return this.emptyPaneDescriptor(id);
  }

  ensureUniqueDocumentPanes() {
    const seen = new Map();
    Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
      if (pane.type !== 'document' || !pane.docId) return;
      if (seen.has(pane.docId)) Object.assign(pane, this.emptyPaneDescriptor(pane.id));
      else seen.set(pane.docId, pane.id);
    });
  }

  initWorkspace() {
    const saved = this.loadWorkspaceState();
    const fallbackDocId = this.state.docs[0]?.id || null;
    const hasSavedPrimary = saved?.panes && Object.prototype.hasOwnProperty.call(saved.panes, 'primary');
    this.state.workspace = {
      mode: saved?.mode === 'split' ? 'split' : 'single',
      focusedPaneId: saved?.focusedPaneId || 'primary',
      splitRatio: Number.isFinite(Number(saved?.splitRatio)) ? Math.min(.78, Math.max(.32, Number(saved.splitRatio))) : .58,
      panes: {
        primary: this.normalizePaneDescriptor(saved?.panes?.primary || {}, 'primary', hasSavedPrimary ? null : fallbackDocId),
        secondary: this.normalizePaneDescriptor(saved?.panes?.secondary || {}, 'secondary'),
      },
    };
    this.ensureUniqueDocumentPanes();
    if (this.state.workspace.mode !== 'split') {
      this.state.workspace.panes.secondary = this.emptyPaneDescriptor('secondary');
      this.state.workspace.focusedPaneId = 'primary';
    }
    if (!this.getPane(this.state.workspace.focusedPaneId)) this.state.workspace.focusedPaneId = 'primary';
    
    const activeDocId = this.getFocusedDoc()?.id || this.getPane('primary')?.docId;
    if (activeDocId) {
      this.state.activeDocId = activeDocId;
    }
  }

  loadWorkspaceState() {
    return safeParseJson(safeGetStorageItem(localStorage, 'nocturne-workspace-v1', 'null'), null, 'nocturne-workspace-v1');
  }

  persistWorkspaceState() {
    const ws = this.state.workspace;
    if (!ws) return;
    this.ensureUniqueDocumentPanes();
    safeSetStorageItem(localStorage, 'nocturne-workspace-v1', JSON.stringify({
      mode: ws.mode,
      splitRatio: ws.splitRatio,
      focusedPaneId: ws.focusedPaneId,
      panes: {
        primary: this.clonePaneDescriptor(ws.panes.primary),
        secondary: this.clonePaneDescriptor(ws.panes.secondary),
      },
    }));
  }

  getPane(paneId = this.state.workspace?.focusedPaneId || 'primary') {
    return this.state.workspace?.panes?.[paneId] || null;
  }

  getFocusedPane() {
    return this.getPane(this.state.workspace?.focusedPaneId || 'primary');
  }

  getDocForPane(paneId = this.state.workspace?.focusedPaneId || 'primary') {
    const pane = this.getPane(paneId);
    return pane?.type === 'document' ? this.state.docs.find((doc) => doc.id === pane.docId) || null : null;
  }

  getFocusedDoc() {
    return this.getDocForPane(this.state.workspace?.focusedPaneId || 'primary');
  }

  getFocusedEditable() {
    const paneId = this.state.workspace?.focusedPaneId || 'primary';
    const doc = this.getDocForPane(paneId);
    if (!doc) return null;
    return document.querySelector(`.workspace-pane[data-pane-id="${paneId}"] .page-content[data-doc-id="${CSS.escape(doc.id)}"]`);
  }

  assistantDocumentProblem() {
    const paneId = this.state.workspace?.focusedPaneId || 'primary';
    const pane = this.getPane(paneId);
    const doc = this.getDocForPane(paneId);
    if (!pane || pane.type !== 'document' || !pane.docId || !doc) return 'Нет активного документа. Создайте или откройте рукопись.';
    if (!this.getFocusedEditable()) return 'Документ ещё не готов к редактированию. Откройте рукопись в рабочей области.';
    return '';
  }

  assistantProviderProblem() {
    const s = this.state.settings;
    if (s.aiProvider === 'local') return 'Ассистент не настроен. Выберите провайдера или подключите Ollama.';
    if (!String(s.aiEndpoint || '').trim()) return 'У провайдера ИИ не указан endpoint.';
    if (!String(s.aiModel || '').trim()) return 'У провайдера ИИ не указана модель.';
    if (!['ollama'].includes(s.aiProvider) && !String(s.aiKey || '').trim()) return 'У провайдера ИИ не указан API key.';
    return '';
  }

  ensureAssistantDocumentContext({ showToast = true, updateOutput = true } = {}) {
    const message = this.assistantDocumentProblem();
    if (!message) return { ok: true, doc: this.getFocusedDoc(), editable: this.getFocusedEditable() };
    this.clearSuggestion();
    if (showToast) this.toast('Откройте или создайте документ, чтобы использовать ассистента.');
    if (updateOutput) this.setAssistantOutput(message, 'no-document');
    this.updateAssistantPanelState();
    return { ok: false, message };
  }

  ensureAssistantProvider({ showToast = true, updateOutput = true } = {}) {
    const message = this.assistantProviderProblem();
    if (!message) return { ok: true };
    this.clearSuggestion();
    if (showToast) this.toast(message);
    if (updateOutput) this.setAssistantOutput(message, 'provider-missing');
    this.updateAssistantPanelState();
    return { ok: false, message };
  }

  setAssistantOutput(message, tone = 'idle') {
    this.assistantPanelMessage = message || '';
    this.assistantState = tone || 'idle';
    const output = document.getElementById('ai-output');
    if (!output) return;
    output.dataset.tone = tone;
    output.textContent = message || '';
  }

  assistantBusyMessage(kind = this.assistantBusyKind) {
    return {
      proofread: 'Проверяю текст…',
      'lore-check': 'Проверяю лор…',
      continue: 'Готовлю продолжение…',
      style: 'Переписываю фрагмент…',
      repair: 'Исправляю формат ответа…',
    }[kind] || 'Ассистент анализирует текст…';
  }

  setAssistantBusy(kind) {
    this.assistantBusyKind = kind;
    this.setAssistantOutput(this.assistantBusyMessage(kind), 'busy');
    this.updateAssistantPanelState();
  }

  

  setFocusedPane(paneId) {
    if (!this.getPane(paneId)) return;
    const previousPaneId = this.state.workspace.focusedPaneId;
    const previousDocId = this.getFocusedDoc()?.id || null;
    this.state.workspace.focusedPaneId = paneId;
        this.persistWorkspaceState();
    this.updateWorkspaceFocusClasses();
    const nextDocId = this.getFocusedDoc()?.id || null;
    if (nextDocId) {
      this.state.activeDocId = nextDocId;
    }
    if (previousPaneId !== paneId || previousDocId !== nextDocId) {
      this.clearSuggestionIfStale();
      this.renderDocs();
      this.renderNotes();
      this.renderFloatingNotes();
    }
    this.updateToolbarState();
    this.updateAssistantPanelState();
    this.renderReviewNavigator();
    this.updateReviewHighlights();
    this.renderSaveIndicator();
  }

  openInPane(paneId, descriptor = {}) {
    const pane = this.getPane(paneId);
    if (!pane) return;
    if (descriptor.type === 'document' && descriptor.docId) {
      const existingPaneId = this.paneIdForOpenDoc(descriptor.docId);
      if (existingPaneId && existingPaneId !== paneId) {
        this.state.workspace.focusedPaneId = existingPaneId;
                this.persistWorkspaceState();
        this.updateWorkspaceFocusClasses();
        this.renderDocs();
        this.renderNotes();
        this.renderFloatingNotes();
        this.renderSaveIndicator();
        this.toast('Документ уже открыт в другой области.');
        return;
      }
    }
    Object.assign(pane, { type: null, docId: null, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null }, descriptor, { id: paneId });
    this.state.workspace.focusedPaneId = paneId;
        this.persistWorkspaceState();
    this.renderWorkspace();
    this.renderFloatingNotes();
    this.clearSuggestionIfStale();
  }

  openSecondaryPane(descriptor = {}) {
    this.state.workspace.mode = 'split';
    this.openInPane('secondary', descriptor.type ? descriptor : { type: null });
  }

  closeSecondaryPane() {
    this.state.workspace.mode = 'single';
    this.state.workspace.panes.secondary = this.emptyPaneDescriptor('secondary');
    this.state.workspace.focusedPaneId = 'primary';
        this.persistWorkspaceState();
    this.renderWorkspace();
    this.renderFloatingNotes();
    this.clearSuggestionIfStale();
  }

  toggleSplitMode() {
    if (this.state.workspace.mode === 'split') {
      this.closeSecondaryPane();
      return;
    }
    this.state.workspace.mode = 'split';
    this.state.workspace.panes.secondary = this.emptyPaneDescriptor('secondary');
    this.persistWorkspaceState();
    this.renderWorkspace();
    this.renderFloatingNotes();
    this.clearSuggestionIfStale();
  }

  toggleSplitMenu() {
    const willOpen = !this.isFloatingMenuOpen('split');
    if (willOpen) this.openFloatingMenu('split');
    else this.closeFloatingMenu('split');
    this.updateSplitMenuState();
  }

  hideSplitMenu() {
    this.closeFloatingMenu('split', { animate: false });
  }

  floatingMenuElement(key) {
    return {
      kb: document.getElementById('kb-menu'),
      format: document.getElementById('format-menu'),
      split: document.getElementById('split-menu'),
      notes: document.getElementById('floating-note-popover'),
      search: document.getElementById('search-menu'),
      review: document.getElementById('review-issue-menu'),
      doc: document.getElementById('doc-menu-portal'),
      context: document.getElementById('app-context-menu'),
    }[key] || null;
  }

  floatingMenuSurface(key) {
    return this.floatingMenuElement(key);
  }

  menuOpenClass(key) {
    return key === 'review' ? 'open' : key === 'doc' ? 'open' : key === 'context' ? 'active' : 'active';
  }

  isFloatingMenuOpen(key) {
    return !!this.floatingMenuElement(key)?.classList.contains(this.menuOpenClass(key));
  }

  floatingMenuAnchor(key) {
    return {
      kb: document.querySelector('#kb-dropdown [data-action="toggle-kb-menu"]'),
      format: document.querySelector('#format-dropdown [data-action="toggle-format-menu"]'),
      split: document.querySelector('#split-menu-wrap [data-action="toggle-split-menu"]'),
      notes: document.querySelector('#floating-note-menu-wrap [data-floating-note-menu-anchor]'),
      search: document.querySelector('#search-menu-wrap [data-action="toggle-search-menu"]'),
      review: document.querySelector('.review-issue-dropdown [data-action="toggle-review-issue-menu"]'),
    }[key] || null;
  }

  floatingMenuAnchorWrapper(key) {
    return {
      kb: document.getElementById('kb-dropdown'),
      format: document.getElementById('format-dropdown'),
      split: document.getElementById('split-menu-wrap'),
      notes: document.getElementById('floating-note-menu-wrap'),
      search: document.getElementById('search-menu-wrap'),
      review: document.querySelector('.review-issue-dropdown'),
    }[key] || null;
  }

  positionFloatingToolbarMenu(key, anchor = this.floatingMenuAnchor(key)) {
    const surface = this.floatingMenuSurface(key);
    if (!surface || !anchor || !['kb', 'format', 'split', 'notes', 'search', 'review'].includes(key)) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = surface.getBoundingClientRect();
    const margin = 10;
    const gap = 10;
    const alignLeft = ['kb', 'format', 'review'].includes(key);
    let left = alignLeft ? anchorRect.left : anchorRect.right - menuRect.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
    const below = anchorRect.bottom + gap;
    const above = anchorRect.top - menuRect.height - gap;
    let top = below + menuRect.height <= window.innerHeight - margin ? below : above;
    top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));
    surface.style.left = `${Math.round(left)}px`;
    surface.style.top = `${Math.round(top)}px`;
  }

  updateActiveFloatingMenuPosition() {
    if (!this.activeFloatingMenuKey) return;
    this.positionFloatingToolbarMenu(this.activeFloatingMenuKey);
  }

  syncFloatingMenuPortalState() {
    const portal = document.getElementById('floating-menu-portal');
    if (!portal) return;
    const hasOpenMenu = ['kb', 'format', 'split', 'notes', 'search', 'review']
      .some((key) => this.isFloatingMenuOpen(key));
    portal.setAttribute('aria-hidden', hasOpenMenu ? 'false' : 'true');
  }

  openFloatingMenu(key) {
    this.closeAllFloatingMenus({ except: key, immediateLogic: true });
    const el = this.floatingMenuElement(key);
    if (!el) return;
    const surface = this.floatingMenuSurface(key);
    clearTimeout(this.floatingMenuCloseTimers.get(key));
    this.floatingMenuCloseTimers.delete(key);
    el.classList.remove('popover-closing');
    surface?.classList.remove('popover-closing');
    this.positionFloatingToolbarMenu(key);
    el.classList.add(this.menuOpenClass(key));
    this.floatingMenuAnchorWrapper(key)?.classList.add('active');
    if (surface && surface !== el) {
      el.removeAttribute('aria-hidden');
      surface.setAttribute('aria-hidden', 'false');
    } else {
      el.setAttribute('aria-hidden', 'false');
    }
    el.style.pointerEvents = '';
    if (surface && surface !== el) surface.style.pointerEvents = '';
    this.activeFloatingMenuKey = key;
    if (key === 'split') this.splitMenuOpen = true;
    this.syncFloatingMenuPortalState();
    requestAnimationFrame(() => this.positionFloatingToolbarMenu(key));
  }

  closeFloatingMenu(key, options = {}) {
    const { animate = true } = options;
    const el = this.floatingMenuElement(key);
    if (!el) return;
    const surface = this.floatingMenuSurface(key);
    clearTimeout(this.floatingMenuCloseTimers.get(key));
    this.floatingMenuCloseTimers.delete(key);
    el.classList.remove(this.menuOpenClass(key));
    this.floatingMenuAnchorWrapper(key)?.classList.remove('active');
    if (surface && surface !== el) {
      el.removeAttribute('aria-hidden');
      surface.setAttribute('aria-hidden', 'true');
    } else {
      el.setAttribute('aria-hidden', 'true');
    }
    if (surface) surface.style.pointerEvents = 'none';
    if (surface === el) el.style.pointerEvents = 'none';
    if (this.activeFloatingMenuKey === key) this.activeFloatingMenuKey = '';
    if (key === 'split') this.splitMenuOpen = false;
    if (key === 'context') this.state.contextMenu = null;
    if (animate) {
      (surface || el).classList.add('popover-closing');
      const timer = setTimeout(() => {
        (surface || el).classList.remove('popover-closing');
        this.floatingMenuCloseTimers.delete(key);
      }, 180);
      this.floatingMenuCloseTimers.set(key, timer);
    } else {
      (surface || el).classList.remove('popover-closing');
    }
    this.syncFloatingMenuPortalState();
  }

  closeAllFloatingMenus(options = '') {
    const except = typeof options === 'string' ? options : (options?.except || '');
    ['kb', 'format', 'split', 'notes', 'search', 'review', 'doc', 'context'].forEach((key) => {
      if (key !== except) this.closeFloatingMenu(key, { animate: key !== 'doc' && key !== 'context' });
    });
  }

  updateSplitMenuState() {
    const wrap = document.getElementById('split-menu-wrap');
    const menu = document.getElementById('split-menu');
    const isSplit = this.state.workspace?.mode === 'split';
    wrap?.classList.toggle('split-active', isSplit);
    menu?.classList.toggle('split-active', isSplit);
  }

  openSplitWithEmptyPane(emptySide = 'right') {
    const currentDoc = this.getFocusedDoc();
    this.state.workspace.mode = 'split';
    if (emptySide === 'left') {
      this.state.workspace.panes.primary = this.emptyPaneDescriptor('primary');
      this.state.workspace.panes.secondary = currentDoc
        ? { id: 'secondary', type: 'document', docId: currentDoc.id, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null }
        : this.emptyPaneDescriptor('secondary');
      this.state.workspace.focusedPaneId = 'primary';
    } else {
      this.state.workspace.panes.primary = currentDoc
        ? { id: 'primary', type: 'document', docId: currentDoc.id, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null }
        : this.emptyPaneDescriptor('primary');
      this.state.workspace.panes.secondary = this.emptyPaneDescriptor('secondary');
      this.state.workspace.focusedPaneId = 'secondary';
    }
        this.persistWorkspaceState();
    this.renderWorkspace();
    this.renderDocs();
    this.renderFloatingNotes();
    this.toast(emptySide === 'left' ? 'Пустая область открыта слева.' : 'Пустая область открыта справа.');
  }

  renderWorkspace() {
    this.cleanupSortableDragState();
    const stage = document.getElementById('workspace-stage');
    if (!stage || !this.state.workspace) return;
    const ws = this.state.workspace;
    stage.dataset.mode = ws.mode;
    stage.style.setProperty('--split-primary', `${ws.splitRatio * 100}%`);
    stage.style.setProperty('--split-secondary', `${(1 - ws.splitRatio) * 100}%`);
    ['primary', 'secondary'].forEach((paneId) => {
      const paneEl = stage.querySelector(`[data-pane-id="${paneId}"]`);
      if (!paneEl) return;
      this.nocturneEditor?.destroy(paneId);
      paneEl.innerHTML = this.renderPane(paneId);
    });
    ['primary', 'secondary'].forEach((paneId) => {
      if (this.getPane(paneId)?.type === 'document') this.renderEditor(paneId);
    });
    this.updateWorkspaceFocusClasses();
    this.disableBrowserSpellcheck();
    this.clearSuggestionIfStale();
    this.updateAssistantPanelState();
    this.updateSplitMenuState();
  }

  renderWorkspacePane(paneId) {
    const stage = document.getElementById('workspace-stage');
    const paneEl = stage?.querySelector(`[data-pane-id="${paneId}"]`);
    if (!paneEl) return;
    this.nocturneEditor?.destroy(paneId);
    paneEl.innerHTML = this.renderPane(paneId);
    if (this.getPane(paneId)?.type === 'document') this.renderEditor(paneId);
    this.updateWorkspaceFocusClasses();
    this.disableBrowserSpellcheck();
    this.clearSuggestionIfStale();
    this.updateAssistantPanelState();
  }

  renderPane(paneId) {
    const pane = this.getPane(paneId);
    if (this.isSingleWorkspaceEmptyPane(paneId, pane)) {
      return `
        <div class="workspace-pane-body workspace-single-empty">
          ${this.singleWorkspaceEmptyMarkup()}
        </div>
      `;
    }
    const isSecondary = paneId === 'secondary';
    const title = this.paneTitle(pane);
    const kind = this.paneKindLabel(pane);
    const close = isSecondary && this.state.workspace.mode === 'split'
      ? '<button class="btn-icon" data-action="close-secondary-pane" title="Закрыть правую область"><i class="bx bx-x"></i></button>'
      : '';
    return `
      <header class="workspace-pane-header">
        <div><small>${kind}</small><strong>${escapeHtml(title)}</strong></div>
        ${close}
      </header>
      <div class="workspace-pane-body">
        ${this.renderPaneBody(paneId)}
      </div>
      <div class="pane-drop-overlay" data-pane-drop="${paneId}">
        <div><i class="bx bx-file-import"></i><span>${pane?.type ? 'Открыть здесь' : 'Открыть документ здесь'}</span></div>
      </div>
    `;
  }

  renderPaneBody(paneId) {
    const pane = this.getPane(paneId);
    if (!pane?.type) {
      return `<div class="workspace-empty">
        <i class="bx bx-sidebar"></i>
        <h3>${paneId === 'primary' ? 'Левая область свободна' : 'Правая область свободна'}</h3>
        <p>Откройте здесь документ, карточку персонажа или вкладку Базы знаний.</p>
      </div>`;
    }
    if (pane.type === 'document') {
      if (!this.getDocForPane(paneId)) {
        return this.emptyStateMarkup('bx-file-plus', 'Начните новую рукопись', 'Создайте первый документ, чтобы начать писать.', 'new-doc', 'Создать документ');
      }
      return `<div class="editor-scroll-area" data-editor-container data-pane-id="${paneId}"></div>`;
    }
    if (pane.type === 'character-detail' || pane.type === 'location-detail' || pane.type === 'note-detail') return this.renderLoreDetailPane(pane);
    if (pane.type === 'kb-tab') return this.renderKbPane(paneId, pane);
    return '';
  }

  isSingleWorkspaceEmptyPane(paneId, pane = this.getPane(paneId)) {
    if (this.state.workspace?.mode === 'split' || paneId !== 'primary') return false;
    if (!pane?.type) return true;
    return pane.type === 'document' && !this.getDocForPane(paneId);
  }

  singleWorkspaceEmptyMarkup() {
    return this.emptyStateMarkup('bx-file-plus', 'Начните новую рукопись', 'Создайте первый документ, чтобы начать писать.', 'new-doc', 'Создать документ');
  }

  paneTitle(pane) {
    if (!pane?.type) return 'Пустая область';
    if (pane.type === 'document') return this.state.docs.find((doc) => doc.id === pane.docId)?.title || 'Документ';
    if (pane.type === 'kb-tab') return { characters: 'Персонажи', locations: 'Локации', timeline: 'Таймлайн' }[pane.kbTab] || 'База знаний';
    const list = pane.entityType === 'location' ? this.state.lore.locations : this.state.lore.characters;
    const entity = list.find((item) => item.id === pane.entityId);
    return this.entityDisplayName(entity) || 'Досье';
  }

  paneKindLabel(pane) {
    if (!pane?.type) return 'Split-screen';
    if (pane.type === 'document') return 'Документ';
    if (pane.type === 'kb-tab') return 'База знаний';
    return pane.entityType === 'location' ? 'Локация' : 'Персонаж';
  }

  renderLoreDetailPane(pane) {
    const type = pane.entityType === 'location' ? 'locations' : pane.entityType === 'note' ? 'notes' : 'characters';
    const item = this.state.lore[type]?.find((entry) => entry.id === pane.entityId);
    if (!item) return '<div class="workspace-empty"><p>Карточка не найдена.</p></div>';
    return this.renderLoreDetail(type, item);
  }

  renderKbPane(paneId, pane) {
    const tab = pane?.kbTab || 'characters';
    if (tab === 'locations') {
      const locs = [...this.state.lore.locations].sort((a, b) => a.order - b.order);
      return `<section class="kb-pane-section"><h2>Локации</h2><div class="locations-grid">${locs.length ? locs.map((item) => this.locationCard(item, false)).join('') : this.emptyStateMarkup('bx-map-alt', 'Локаций пока нет.', 'Добавьте первое место, чтобы связать сцену с миром.', 'new-lore', 'Добавить место', 'data-lore-type="locations"')}</div></section>`;
    }
    if (tab === 'timeline') {
      if (pane?.subtimelineParentId) return this.renderPaneSubtimeline(paneId, pane.subtimelineParentId);
      const time = [...this.state.lore.timeline].sort((a, b) => (a.order - b.order) || parseTimelineRank(a.date) - parseTimelineRank(b.date));
      return `<section class="kb-pane-section"><h2>Таймлайн</h2><div class="timeline-container">${time.length ? time.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1 })).join('') : this.emptyStateMarkup('bx-git-commit', 'Хронология пока пуста.', 'Добавьте первое событие, чтобы собрать порядок истории.', 'new-lore', 'Добавить событие', 'data-lore-type="timeline"')}</div></section>`;
    }
    const chars = [...this.state.lore.characters].sort((a, b) => a.order - b.order);
    return `<section class="kb-pane-section"><h2>Персонажи</h2><div class="character-grid">${chars.length ? chars.map((item) => this.characterCard(item, false)).join('') : this.emptyStateMarkup('bx-user-pin', 'Персонажей пока нет.', 'Создайте первый профиль для распознавания имён в тексте.', 'new-lore', 'Создать профиль', 'data-lore-type="characters"')}</div></section>`;
  }

  renderPaneSubtimeline(paneId, parentId) {
    const parent = this.timelineEvent(parentId);
    if (!parent) {
      return `<section class="kb-pane-section kb-pane-subtimeline">
        <button class="pill-btn" data-action="close-pane-subtimeline" data-pane-id="${escapeHtml(paneId)}"><i class="bx bx-left-arrow-alt"></i> Назад к таймлайну</button>
        <div class="workspace-empty"><p>Сабтаймлайн не найден.</p></div>
      </section>`;
    }
    const events = this.subtimelineEvents(parent);
    return `<section class="kb-pane-section kb-pane-subtimeline" data-parent-id="${escapeHtml(parent.id)}">
      <div class="kb-pane-breadcrumb">База знаний / Таймлайн / Сабтаймлайн</div>
      <button class="pane-back-btn" data-action="close-pane-subtimeline" data-pane-id="${escapeHtml(paneId)}"><i class="bx bx-left-arrow-alt"></i> Назад к таймлайну</button>
      <div class="kb-pane-subtimeline-head">
        <span>Сабтаймлайн</span>
        <h2>${escapeHtml(parent.title || 'Событие')}</h2>
        <p>${escapeHtml(parent.body || '')}</p>
      </div>
      <div class="timeline-container subtimeline-container pane-subtimeline-list">
        ${events.length
          ? events.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1, isSub: true, parentId: parent.id })).join('')
          : this.emptyStateMarkup('bx-git-branch', 'У этого события пока нет вложенных событий.', 'Добавьте саб-событие в полной Базе знаний, если нужно развернуть ветку.')}
      </div>
    </section>`;
  }

  openPaneSubtimeline(paneId, parentId) {
    const pane = this.getPane(paneId);
    if (!pane || pane.type !== 'kb-tab' || pane.kbTab !== 'timeline' || !this.timelineEvent(parentId)) return false;
    pane.subtimelineParentId = parentId;
    this.persistWorkspaceState();
    this.renderWorkspacePane(paneId);
    return true;
  }

  emptyStateMarkup(icon, title, text, action = '', actionLabel = '', extraAttrs = '') {
    return `<div class="empty-card">
      <i class="bx ${icon}"></i>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
      ${action ? `<button class="pill-btn ai-btn" data-action="${action}" ${extraAttrs}>${escapeHtml(actionLabel)}</button>` : ''}
    </div>`;
  }

  closePaneSubtimeline(paneId) {
    const pane = this.getPane(paneId);
    if (!pane || pane.type !== 'kb-tab') return false;
    pane.subtimelineParentId = null;
    this.persistWorkspaceState();
    this.renderWorkspacePane(paneId);
    return true;
  }

  updateWorkspaceFocusClasses() {
    document.querySelectorAll('.workspace-pane').forEach((pane) => {
      pane.classList.toggle('active-pane', pane.dataset.paneId === this.state.workspace?.focusedPaneId);
    });
    const isDoc = this.getFocusedPane()?.type === 'document';
    document.querySelector('.toolbar-center')?.classList.toggle('toolbar-disabled', !isDoc || this.state.reviewMode === 'editor');
    if (!isDoc) {
      window.getSelection()?.removeAllRanges();
      const caret = document.getElementById('custom-caret');
      if (caret) caret.style.display = 'none';
    }
  }

  applyReviewMode() {
    const mode = this.state.reviewMode || 'write';
    document.body.dataset.activeReviewMode = mode;
    delete document.body.dataset.reviewMode;
    document.querySelectorAll('[data-review-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.reviewMode === mode);
    });
    document.querySelectorAll('.page-content').forEach((editable) => {
      const doc = this.state.docs.find((item) => item.id === editable.dataset.docId);
      const isLocked = !!(doc?.locked || mode === 'editor');
      editable.contentEditable = 'false';
      editable.classList.toggle('review-readonly', mode === 'editor');
      const paneId = editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId;
      if (paneId) {
        this.nocturneEditor?.setEditable(paneId, !isLocked);
      }
    });
    this.updateWorkspaceFocusClasses();
  }

  setReviewMode(mode) {
    if (!['write', 'editor', 'finalization'].includes(mode)) return;
    this.state.reviewMode = mode;
    safeSetStorageItem(localStorage, 'nocturne-review-mode', mode);
    this.applyReviewMode();
    this.updateReviewHighlights();
    this.renderReviewNavigator();
    this.renderReviewToolbarSlot();
    this.toast(mode === 'editor' ? 'Режим редактора: текст защищён от ввода.' : mode === 'finalization' ? 'Режим финализации: правки видны и доступны.' : 'Режим письма.', 950);
  }

  setSaveStatus(state, docId = this.getFocusedDoc()?.id || this.state.activeDocId, message = '') {
    if (!docId) return;
    this.state.saveStatusByDoc[docId] = { state, message, updatedAt: Date.now() };
    this.renderSaveIndicator();
  }

  renderSaveIndicator() {
    const el = document.getElementById('save-indicator');
    if (!el) return;
    const doc = this.getFocusedDoc();
    if (!doc || doc.locked) {
      if (el.innerHTML !== '' || el.className !== 'save-indicator' || el.title !== '') {
        el.innerHTML = '';
        el.className = 'save-indicator';
        el.title = '';
      }
      return;
    }
    const status = this.state.saveStatusByDoc[doc.id] || { state: 'saved', updatedAt: doc.updatedAt || Date.now(), message: '' };
    const time = status.updatedAt ? new Date(status.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const meta = {
      saving: ['bx-cloud-upload', 'Сохранение…'],
      error: ['bx-error-circle', 'Ошибка сохранения'],
      saved: ['bx-check-circle', 'Сохранено'],
      idle: ['bx-check-circle', 'Сохранено'],
    }[status.state] || ['bx-check-circle', 'Сохранено'];
    const newClass = `save-indicator ${status.state}`;
    const newTitle = status.message || (time ? `Последнее сохранение: ${time}` : meta[1]);
    const newHtml = `<i class="bx ${meta[0]}"></i><span>${meta[1]}</span>`;
    if (el.className !== newClass) el.className = newClass;
    if (el.title !== newTitle) el.title = newTitle;
    if (el.innerHTML !== newHtml) el.innerHTML = newHtml;
    this.renderMobileTopbarStatus();
  }

  isAndroidRuntime() {
    this.runtime = this.runtime || detectRuntime();
    return !!this.runtime.isAndroid;
  }

  isCapacitorRuntime() {
    this.runtime = this.runtime || detectRuntime();
    return !!this.runtime.isCapacitor;
  }

  isMobileLayout() {
    const coarse = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
    return this.isAndroidRuntime() || this.isCapacitorRuntime() || window.innerWidth <= 768 || (coarse && window.innerWidth <= 900);
  }

  isEditable(editable) {
    if (!editable) return false;
    const pm = editable.querySelector('.ProseMirror');
    if (pm) return pm.getAttribute('contenteditable') !== 'false';
    return editable.getAttribute('contenteditable') !== 'false';
  }

  mobileShellClasses() {
    const fullscreen = this.isMobileLayout() && this.mobilePanelMode() === 'fullscreen' && !!this.state.mobile.panel;
    return [
      this.isMobileLayout() ? 'is-mobile mobile-shell-active' : '',
      this.isAndroidRuntime() ? 'is-android' : '',
      this.isCapacitorRuntime() ? 'is-capacitor' : '',
      `mobile-tab-${this.state.mobile.activeTab || 'write'}`,
      fullscreen ? 'mobile-fullscreen-panel' : '',
      this.state.mobile.keyboardOpen ? 'mobile-keyboard-open' : '',
      this.state.mobile.editorFocused ? 'mobile-editor-focused' : '',
      this.state.mobile.formatBarVisible ? 'mobile-format-visible' : '',
      this.state.mobile.formatBarMode ? `mobile-format-${this.state.mobile.formatBarMode}` : '',
      this.state.settings.reduceMobileAnimations ? 'reduce-mobile-animations' : '',
    ].filter(Boolean).join(' ');
  }

  updateRuntimeClasses() {
    const mobile = this.isMobileLayout();
    const android = this.isAndroidRuntime();
    const capacitor = this.isCapacitorRuntime();
    const fullscreen = mobile && this.mobilePanelMode() === 'fullscreen' && !!this.state.mobile.panel;
    document.body.classList.toggle('is-mobile', mobile);
    document.body.classList.toggle('mobile-shell-active', mobile);
    document.body.classList.toggle('is-android', android);
    document.body.classList.toggle('is-capacitor', capacitor);
    ['write', 'docs', 'lore', 'ai', 'more'].forEach((tab) => document.body.classList.toggle(`mobile-tab-${tab}`, mobile && this.state.mobile.activeTab === tab));
    document.body.classList.toggle('mobile-fullscreen-panel', fullscreen);
    document.body.classList.toggle('mobile-keyboard-open', mobile && !!this.state.mobile.keyboardOpen);
    document.body.classList.toggle('mobile-editor-focused', mobile && !!this.state.mobile.editorFocused);
    document.body.classList.toggle('mobile-format-visible', mobile && !!this.state.mobile.formatBarVisible);
    ['hidden', 'typing', 'selection'].forEach((mode) => {
      document.body.classList.toggle(`mobile-format-${mode}`, mobile && this.state.mobile.formatBarMode === mode);
    });
    document.body.classList.toggle('reduce-mobile-animations', !!this.state.settings.reduceMobileAnimations);
    const shell = document.getElementById('app-shell');
    if (shell) {
      shell.classList.toggle('is-mobile', mobile);
      shell.classList.toggle('mobile-shell-active', mobile);
      shell.classList.toggle('is-android', android);
      shell.classList.toggle('is-capacitor', capacitor);
      ['write', 'docs', 'lore', 'ai', 'more'].forEach((tab) => shell.classList.toggle(`mobile-tab-${tab}`, mobile && this.state.mobile.activeTab === tab));
      shell.classList.toggle('mobile-fullscreen-panel', fullscreen);
      shell.classList.toggle('mobile-keyboard-open', mobile && !!this.state.mobile.keyboardOpen);
      shell.classList.toggle('mobile-editor-focused', mobile && !!this.state.mobile.editorFocused);
      shell.classList.toggle('mobile-format-visible', mobile && !!this.state.mobile.formatBarVisible);
      ['hidden', 'typing', 'selection'].forEach((mode) => {
        shell.classList.toggle(`mobile-format-${mode}`, mobile && this.state.mobile.formatBarMode === mode);
      });
      shell.classList.toggle('reduce-mobile-animations', !!this.state.settings.reduceMobileAnimations);
    }
  }

  handleMobileViewportChange() {
    const focusedEditor = !!document.activeElement?.closest?.('.page-content');
    const focusedEditable = !!document.activeElement?.closest?.('.page-content, [data-mobile-notes-input], #notes-input, input, textarea, [contenteditable="true"]');
    const previousKeyboardOpen = !!this.state.mobile.keyboardOpen;
    const keyboardOpen = this.isMobileLayout() && focusedEditable
      ? (window.visualViewport ? window.visualViewport.height < window.innerHeight * 0.82 : true)
      : false;
    const changed = this.state.mobile.keyboardOpen !== keyboardOpen;
    this.state.mobile.keyboardOpen = keyboardOpen;
    const customSelection = !!this.selectionController?.active;
    this.state.mobile.editorFocused = focusedEditor && !customSelection;
    if (this.isMobileLayout()) {
      if (customSelection) {
        this.state.mobile.formatBarMode = 'selection';
        this.state.mobile.formatBarVisible = true;
      } else if (focusedEditor && keyboardOpen) {
        this.state.mobile.formatBarMode = 'typing';
        this.state.mobile.formatBarVisible = true;
      } else if (previousKeyboardOpen && !keyboardOpen) {
        this.state.mobile.editorFocused = false;
        this.state.mobile.formatBarMode = 'hidden';
        this.state.mobile.formatBarVisible = false;
      } else {
        this.state.mobile.formatBarMode = focusedEditor ? 'typing' : 'hidden';
        this.state.mobile.formatBarVisible = focusedEditor && keyboardOpen;
      }
    }
    this.updateRuntimeClasses();
    if (changed) this.scrollCaretIntoMobileView();
    if (changed && previousKeyboardOpen && !keyboardOpen && !customSelection) this.clearMobileEditorSelection({ keepNative: false });
  }

  scrollCaretIntoMobileView() {
    const editable = document.activeElement?.closest?.('.page-content, .mobile-notes-editor');
    if (!editable || !this.isMobileLayout()) return;
    window.setTimeout(() => editable.scrollIntoView({ block: 'nearest', inline: 'nearest' }), 80);
  }

  renderMobileTopbarStatus() {
    const el = document.getElementById('mobile-save-status');
    if (!el) return;
    const doc = this.getFocusedDoc();
    const status = doc ? (this.state.saveStatusByDoc[doc.id]?.state || 'saved') : 'idle';
    const icon = status === 'saving' ? 'bx-cloud-upload' : status === 'error' ? 'bx-error-circle' : 'bx-check-circle';
    const newClass = `mobile-save-dot ${status}`;
    const newHtml = `<i class="bx ${icon}"></i>`;
    if (el.className !== newClass) el.className = newClass;
    if (el.innerHTML !== newHtml) el.innerHTML = newHtml;
  }

  renderMobileTopbar() {
    const doc = this.getFocusedDoc() || this.state.docs.find((item) => item.id === this.state.activeDocId);
    return `
      <header class="mobile-topbar">
        <button class="mobile-icon-btn" data-action="mobile-open-docs" aria-label="Документы"><i class="bx bx-menu-alt-left"></i></button>
        <button class="mobile-title-zone" data-action="mobile-open-docs">
          <span>Документ</span>
          <strong>${escapeHtml(doc?.title || 'Нет главы')}</strong>
        </button>
        <div class="mobile-topbar-actions">
          <button class="mobile-icon-btn" data-action="open-command-palette" aria-label="Команды" title="Команды"><i class="bx bx-command"></i></button>
          <span id="mobile-save-status" class="mobile-save-dot saved"><i class="bx bx-check-circle"></i></span>
          <button class="mobile-icon-btn" data-action="mobile-open-actions" aria-label="Действия"><i class="bx bx-dots-vertical-rounded"></i></button>
        </div>
      </header>`;
  }

  renderMobileSystemBar() {
    const battery = this.state.mobile.batteryLevel === null ? '—' : `${this.state.mobile.batteryLevel}%`;
    return `
      <div class="mobile-system-bar" aria-hidden="true">
        <span data-mobile-system-time>${escapeHtml(this.state.mobile.systemTime || new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))}</span>
        <span class="mobile-system-dot"></span>
        <span class="mobile-system-battery"><i class="bx bx-battery"></i><span data-mobile-battery>${escapeHtml(battery)}</span></span>
      </div>`;
  }

  renderMobileBottomNav() {
    const items = [
      ['write', 'bx-edit-alt', 'Писать', 'mobile-tab-write'],
      ['docs', 'bx-file', 'Главы', 'mobile-open-docs'],
      ['lore', 'bx-book-bookmark', 'База', 'mobile-open-lore'],
      ['ai', 'nocturne-ai-icon', 'AI', 'mobile-open-ai'],
      ['more', 'bx-grid-alt', 'Ещё', 'mobile-open-more'],
    ];
    return `<nav class="mobile-bottom-nav" data-active-tab="${escapeHtml(this.state.mobile.activeTab || 'write')}" aria-label="Мобильная навигация">
      ${items.map(([id, icon, label, action]) => `<button class="${this.state.mobile.activeTab === id ? 'active' : ''}" data-action="${action}">${id === 'ai' ? aiIcon('mobile-nav-svg') : `<i class="bx ${icon}"></i>`}<span>${label}</span></button>`).join('')}
    </nav>`;
  }

  mobileTabHeader(title, subtitle = '') {
    return `
      <header class="mobile-tab-header">
        <div>
          <span>Nocturne</span>
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
      </header>`;
  }

  renderMobileTabSurface() {
    const tab = this.state.mobile.activeTab || 'write';
    if (tab === 'write') return '<section class="mobile-tab-surface" id="mobile-tab-surface" aria-hidden="true"></section>';
    return `
      <section class="mobile-tab-surface active mobile-tab-dir-${this.state.mobile.tabDirection >= 0 ? 'forward' : 'back'}" id="mobile-tab-surface" data-mobile-tab="${escapeHtml(tab)}" aria-hidden="false">
        <div class="mobile-tab-content">
          ${this.renderMobileTabContent(tab)}
        </div>
      </section>`;
  }

  renderMobileTabContent(tab = this.state.mobile.activeTab) {
    if (tab === 'docs') return this.renderMobileDocsPanel({ asTab: true });
    if (tab === 'lore') return this.renderMobileKb({ asTab: true });
    if (tab === 'ai') return this.renderMobileAi({ asTab: true });
    if (tab === 'more') return this.renderMobileMorePanel({ asTab: true });
    return '';
  }

  renderMobileOverlay() {
    const panelMode = this.mobilePanelMode();
    return `
      <div class="mobile-overlay ${this.state.mobile.panel ? 'active' : ''} mobile-overlay-${panelMode}" id="mobile-overlay" aria-hidden="${this.state.mobile.panel ? 'false' : 'true'}">
        <section class="mobile-panel mobile-panel-${panelMode}" id="mobile-panel">${this.renderMobilePanel()}</section>
      </div>
      <div class="mobile-format-bar" id="mobile-format-bar">
        <button data-command="bold" aria-label="Жирный"><i class="bx bx-bold"></i></button>
        <button data-command="italic" aria-label="Курсив"><i class="bx bx-italic"></i></button>
        <button data-command="underline" aria-label="Подчеркнуть"><i class="bx bx-underline"></i></button>
        <button data-command="strikeThrough" aria-label="Зачеркнуть"><i class="bx bx-strikethrough"></i></button>
        <button data-format-block="heading" aria-label="Заголовок"><i class="bx bx-heading"></i></button>
        <button data-format-block="quote" aria-label="Цитата"><i class="bx bxs-quote-left"></i></button>
        <button data-action="toggle-search-menu" aria-label="Поиск"><i class="bx bx-search"></i></button>
      </div>`;
  }

  mobilePanelTitle(panel = this.state.mobile.panel) {
    return {
      docs: 'Главы',
      actions: 'Действия',
      more: 'Ещё',
      settings: 'Настройки',
      lore: 'База знаний',
      ai: 'Nocturne AI',
      notes: 'Заметки',
      export: 'Экспорт / резервная копия',
      sync: 'Связь с компьютером',
    }[panel] || 'Nocturne';
  }

  mobilePanelMode(panel = this.state.mobile.panel) {
    if (!panel) return 'screen';
    if (['docs', 'more', 'settings', 'export', 'ai', 'notes', 'lore'].includes(panel)) return 'fullscreen';
    return panel === 'actions' ? 'sheet' : 'screen';
  }

  mobilePanelHeader(title = this.mobilePanelTitle(), subtitle = '') {
    const hasBack = this.mobileCanGoBack();
    return `
      <header class="mobile-panel-header">
        <button class="mobile-icon-btn" data-action="${hasBack ? 'mobile-back' : 'mobile-close-panel'}" aria-label="${hasBack ? 'Назад' : 'Закрыть'}"><i class="bx bx-left-arrow-alt"></i></button>
        <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
        <button class="mobile-icon-btn" data-action="mobile-close-all" aria-label="Закрыть"><i class="bx bx-x"></i></button>
      </header>`;
  }

  renderMobilePanel() {
    const panel = this.state.mobile.panel;
    if (!panel) return '';
    if (panel === 'docs') return this.renderMobileDocsPanel();
    if (panel === 'actions') return this.renderMobileActionsPanel();
    if (panel === 'more') return this.renderMobileMorePanel();
    if (panel === 'settings') return this.renderMobileSettings();
    if (panel === 'lore') return this.renderMobileKb();
    if (panel === 'ai') return this.renderMobileAi();
    if (panel === 'notes') return this.renderMobileNotes();
    if (panel === 'export') return this.renderMobileExport();
    return '';
  }

  renderMobileDocsPanel(options = {}) {
    const q = (this.state.mobile.docsSearch || '').toLowerCase().trim();
    const header = options.asTab ? this.mobileTabHeader('Главы', 'Документы проекта и папки') : this.mobilePanelHeader('Главы', 'Документы проекта и папки');
    return `
      ${header}
      <div class="mobile-panel-body">
        <div class="mobile-search-field"><i class="bx bx-search"></i><input data-mobile-doc-search placeholder="Поиск глав" value="${escapeHtml(this.state.mobile.docsSearch || '')}"></div>
        <div class="mobile-panel-actions"><button class="pill-btn ai-btn" data-action="new-doc"><i class="bx bx-plus"></i> Новая глава</button><button class="pill-btn" data-action="new-folder"><i class="bx bx-folder-plus"></i> Папка</button></div>
        <div class="mobile-doc-folders">
          ${this.state.folders.map((folder) => {
            const collapsed = this.state.collapsedFolders.includes(folder.id);
            let docs = this.state.docs
              .filter((doc) => doc.folderId === folder.id)
              .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order);
            if (q) docs = docs.filter((doc) => `${doc.title} ${doc.description || ''} ${doc.summary || ''}`.toLowerCase().includes(q));
            return `
              <section class="mobile-folder">
                <button class="mobile-folder-head" data-action="toggle-folder" data-folder="${escapeHtml(folder.id)}">
                  <span><i class="bx bx-chevron-${collapsed ? 'right' : 'down'}"></i>${escapeHtml(folder.title)}</span>
                  <small>${docs.length}</small>
                </button>
                <div class="mobile-folder-docs ${collapsed ? 'collapsed' : ''}">
                  ${docs.length ? docs.map((doc) => this.mobileDocCard(doc)).join('') : `<div class="mobile-empty-card"><i class="bx bx-file-blank"></i><span>${q ? 'Совпадений нет' : 'Документов пока нет'}</span><button class="mini-text-btn" data-action="new-doc" data-folder-id="${escapeHtml(folder.id)}">Создать</button></div>`}
                </div>
              </section>`;
          }).join('')}
        </div>
      </div>`;
  }

  mobileDocCard(doc) {
    const words = countWords(docText(doc.ast));
    const updated = doc.updatedAt ? new Date(doc.updatedAt).toLocaleDateString() : '';
    const isBook = doc.docType === 'book-chapter';
    return `
      <article class="doc-item mobile-doc-card ${isBook ? 'book-chapter-card' : ''} ${doc.id === this.state.activeDocId ? 'active' : ''}" data-doc-id="${escapeHtml(doc.id)}">
        <div>
          ${isBook ? `
          <div class="book-chapter-header">
            <span class="book-work-info"><i class="bx bx-library"></i> <span>${escapeHtml(doc.workTitle || 'Книга')}${doc.volume ? ` · ${escapeHtml(doc.volume)}` : ''}</span></span>
          </div>
          ` : ''}
          <h3><i class="bx ${isBook ? 'bx-book-open' : (doc.pinned ? 'bx-pin' : doc.locked ? 'bx-lock' : 'bx-file')}"></i><span>${isBook && doc.chapterNumber ? `<span class="chapter-number">${escapeHtml(doc.chapterNumber)}</span>: ` : ''}${escapeHtml(doc.title || 'Без названия')}</span></h3>
          <p>${escapeHtml(doc.description || doc.summary || 'Без описания')}</p>
          <div class="book-card-footer">
            <small>${words} слов${updated ? ` · ${updated}` : ''}</small>
            ${isBook ? `
            <span class="book-status-inline status-${this.statusSlug(doc.bookStatus)}">
              <span class="status-dot"></span>
              <span class="status-name">${escapeHtml(this.statusShortName(doc.bookStatus))}</span>
            </span>
            ` : ''}
          </div>
        </div>
        <button class="mobile-card-menu doc-menu-btn" data-doc-menu="${escapeHtml(doc.id)}" aria-label="Меню главы"><i class="bx bx-dots-vertical-rounded"></i></button>
      </article>`;
  }

  renderMobileActionsPanel() {
    const doc = this.getFocusedDoc();
    const disabled = doc ? '' : 'disabled';
    const item = (icon, title, subtitle, action, extra = '') => `
      <button class="mobile-action-row" data-action="${action}" ${extra}>
        <span class="mobile-action-icon">${icon === 'nocturne-ai' ? aiIcon('mobile-action-svg') : icon === 'nocturne-sync' ? iconSvg('sync', 'mobile-action-svg') : `<i class="bx ${icon}"></i>`}</span><span><strong>${title}</strong><small>${subtitle}</small></span>
      </button>`;
    return `
      ${this.mobilePanelHeader('Действия', doc?.title || 'Нет активной главы')}
      <div class="mobile-panel-body mobile-action-list">
        <h3>Документ</h3>
        ${item('bx-edit', 'Переименовать', 'Название и описание главы', 'edit-doc', `data-ctx-doc="${escapeHtml(doc?.id || '')}" ${disabled}`)}
        ${item('bx-plus', 'Новая глава', 'Создать новую главу', 'new-doc')}
        ${item('bx-copy', 'Дублировать', 'Копия текущей главы', 'duplicate-doc', `data-ctx-doc="${escapeHtml(doc?.id || '')}" ${disabled}`)}
        ${item('bx-camera', 'Снапшот', 'Снимок текущего состояния', 'manual-snapshot', disabled)}
        ${item('bx-save', 'Сохранить сейчас', 'Сохранить в IndexedDB', 'mobile-save-now', disabled)}
        <h3>Письмо</h3>
        ${item('bx-undo', 'Отменить', 'Отменить ввод', 'mobile-command', 'data-mobile-command="undo"')}
        ${item('bx-redo', 'Повторить', 'Повторить ввод', 'mobile-command', 'data-mobile-command="redo"')}
        ${item('bx-search', 'Поиск / замена', 'Найти и заменить текст', 'open-search-chooser')}
        ${item('bx-target-lock', 'Фокус', 'Дзен-режим', 'toggle-zen')}
        <h3>Проект</h3>
        ${item('bx-archive-out', 'Экспорт .nocturnedump', 'Резервная копия всего проекта', 'export-project-dump')}
        ${item('bx-archive-in', 'Импорт .nocturnedump', 'Загрузить резервную копию', 'import-project-dump')}
        ${item('bx-cog', 'Настройки', 'Настройки приложения', 'mobile-open-settings')}
        <h3>Вид</h3>
        ${item('bx-notepad', 'Заметки', 'Документные и общие заметки', 'mobile-open-notes')}
        ${item('nocturne-ai', 'AI', 'Проверка и творческие инструменты', 'mobile-open-ai')}
        ${item('bx-book-bookmark', 'База знаний', 'Персонажи, локации, таймлайн', 'mobile-open-lore')}
      </div>`;
  }

  renderMobileMorePanel(options = {}) {
    const rows = [
      ['bx-cog', 'Настройки', 'Визуал, редактор, AI, данные', 'mobile-open-settings'],
      ['bx-export', 'Экспорт / импорт', '.nocturnedump, PDF, DOCX', 'mobile-open-export'],
      ['bx-search-alt', 'Поиск / замена', 'Найти или заменить текст', 'open-search-chooser'],
      ['bx-camera', 'Снапшоты', 'Машина времени текущей главы', 'show-history'],
      ['bx-note', 'Заметки', 'Документные, общие и плавающие заметки', 'mobile-open-notes'],
            ['bx-command', 'Палитра команд', 'Быстрый поиск действий', 'open-command-palette'],
      ['bx-info-circle', 'О приложении', 'Nocturne Writer · мобильная оболочка', 'mobile-about'],
      ['bx-reset', 'Сброс настроек UI', 'Документы не удаляются', 'reset-settings'],
    ];
    return `
      ${options.asTab ? this.mobileTabHeader('Ещё', 'Главное мобильное меню') : this.mobilePanelHeader('Ещё', 'Главное мобильное меню')}
      <div class="mobile-panel-body mobile-action-list">
        ${rows.map(([icon, title, subtitle, action]) => `
          <button class="mobile-action-row" data-action="${action}">
            <span class="mobile-action-icon">${icon === 'nocturne-sync' ? iconSvg('sync', 'mobile-action-svg') : `<i class="bx ${icon}"></i>`}</span><span><strong>${title}</strong><small>${subtitle}</small></span>
          </button>`).join('')}
      </div>`;
  }

  renderMobileSettings() {
    const tabs = [
      ['visual', 'bx-palette', 'Визуал и UI'],
      ['editor', 'bx-text', 'Редактор'],
      ['dictionary', 'bx-book-content', 'Словарь'],
      ['review', 'bx-edit-alt', 'Редактура'],
      ['focus', 'bx-target-lock', 'Фокус'],
      ['ai', 'bx-bot', 'AI'],
      ['data', 'bx-shield-quarter', 'Данные'],
            ['export', 'bx-export', 'Экспорт'],
      ['misc', 'bx-slider-alt', 'Прочее'],
    ];
    const active = this.state.mobile.settingsTab;
    if (!active) {
      return `
        ${this.mobilePanelHeader('Настройки', 'Выберите раздел')}
        <div class="mobile-panel-body mobile-action-list">
          ${tabs.map(([id, icon, label]) => `<button class="mobile-action-row" data-mobile-settings-tab="${id}"><span class="mobile-action-icon">${id === 'ai' ? aiIcon('mobile-action-svg') : icon === 'nocturne-sync' ? iconSvg('sync', 'mobile-action-svg') : `<i class="bx ${icon}"></i>`}</span><span><strong>${label}</strong><small>Открыть настройки раздела</small></span></button>`).join('')}
        </div>`;
    }
    const label = tabs.find(([id]) => id === active)?.[2] || 'Настройки';
    const row = (name, note, control) => `<div class="setting-row"><div class="setting-info"><span>${name}</span>${note ? `<small>${note}</small>` : ''}</div><div class="setting-control">${control}</div></div>`;
    const toggle = (key) => `<div class="toggle ${this.state.settings[key] ? 'on' : ''}" data-setting="${key}" data-kind="toggle"></div>`;
    const input = (key, type = 'text') => `<input class="form-control" type="${type}" value="${escapeHtml(this.state.settings[key] || '')}" data-setting="${key}">`;
    return `
      <header class="mobile-panel-header">
        <button class="mobile-icon-btn" data-action="mobile-settings-back" aria-label="Назад"><i class="bx bx-left-arrow-alt"></i></button>
        <div><h2>${escapeHtml(label)}</h2><p>Настройки применяются сразу</p></div>
        <button class="mobile-icon-btn" data-action="mobile-close-all" aria-label="Закрыть"><i class="bx bx-x"></i></button>
      </header>
      <div class="mobile-panel-body mobile-settings-content">${this.settingsContent(active).replace('tab-content active', 'tab-content active mobile-settings-tab-content')}</div>`;
  }

  renderMobileKb(options = {}) {
    const active = this.state.mobile.kbTab || this.state.activeKbTab || 'characters';
    const detail = this.activeLoreDetailItem();
    if (detail && ['characters', 'locations'].includes(detail.type)) return this.renderMobileLoreDetail(detail.type, detail.item);
    if (this.state.activeSubtimelineId) return this.renderMobileSubtimeline(this.state.activeSubtimelineId);
    const q = (this.state.mobile.loreSearch || '').toLowerCase().trim();
    const filter = (item) => !q || `${this.entityDisplayName(item)} ${item.title || ''} ${item.role || ''} ${item.body || ''} ${item.date || ''}`.toLowerCase().includes(q);
    const chars = [...this.state.lore.characters].sort((a, b) => a.order - b.order).filter(filter);
    const locs = [...this.state.lore.locations].sort((a, b) => a.order - b.order).filter(filter);
    const time = [...this.state.lore.timeline].sort((a, b) => (a.order - b.order) || parseTimelineRank(a.date) - parseTimelineRank(b.date)).filter(filter);
    const list = active === 'characters'
      ? (chars.length ? chars.map((item, index) => this.mobileLoreCard('characters', item, index, chars.length)).join('') : this.emptyStateMarkup('bx-user-pin', 'Персонажей пока нет.', 'Создайте первый профиль.', 'new-lore', 'Создать', 'data-lore-type="characters"'))
      : active === 'locations'
        ? (locs.length ? locs.map((item, index) => this.mobileLoreCard('locations', item, index, locs.length)).join('') : this.emptyStateMarkup('bx-map-alt', 'Локаций пока нет.', 'Добавьте место.', 'new-lore', 'Добавить', 'data-lore-type="locations"'))
        : (time.length ? time.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1, draggable: true })).join('') : this.emptyStateMarkup('bx-git-commit', 'Таймлайн пуст.', 'Добавьте событие.', 'new-lore', 'Добавить', 'data-lore-type="timeline"'));
    const zone = active === 'timeline' ? 'timeline' : active;
    return `
      ${options.asTab ? this.mobileTabHeader('База знаний', 'Персонажи, локации и таймлайн') : this.mobilePanelHeader('База знаний', 'Персонажи, локации и таймлайн')}
      <div class="mobile-panel-body">
        <div class="mobile-segmented">
          ${[['characters', 'Персонажи'], ['locations', 'Локации'], ['timeline', 'Таймлайн']].map(([id, label]) => `<button class="${active === id ? 'active' : ''}" data-mobile-kb-tab="${id}">${label}</button>`).join('')}
        </div>
        <div class="mobile-search-field"><i class="bx bx-search"></i><input data-mobile-lore-search placeholder="Поиск в базе" value="${escapeHtml(this.state.mobile.loreSearch || '')}"></div>
        <div class="mobile-panel-actions"><button class="pill-btn ai-btn" data-action="new-lore" data-lore-type="${active}"><i class="bx bx-plus"></i> Добавить</button><span class="mobile-drag-hint"><i class="bx bx-grid-vertical"></i> Удерживайте карточку, чтобы перенести</span></div>
        <div class="mobile-kb-list ${active === 'timeline' ? 'timeline-container timeline-mobile-list' : ''}" data-dnd-zone="${escapeHtml(zone)}">${list}</div>
      </div>`;
  }

  renderMobileKbContentOnly() {
    if (!this.isMobileLayout?.()) return false;
    const surface = document.querySelector('#mobile-tab-surface[data-mobile-tab="lore"] .mobile-tab-content, #mobile-panel .mobile-tab-content, #mobile-panel');
    if (!surface) return false;
    surface.classList.add('mobile-kb-switching');
    surface.innerHTML = this.renderMobileKb({ asTab: !!document.querySelector('#mobile-tab-surface[data-mobile-tab="lore"]') });
    requestAnimationFrame(() => surface.classList.remove('mobile-kb-switching'));
    this.setupMobileKbSortables();
    return true;
  }

  mobileLoreCard(type, item, index, total) {
    const isTimeline = type === 'timeline';
    const title = isTimeline ? (item.title || 'Событие') : this.entityDisplayName(item);
    const subtitle = isTimeline ? [item.date, item.body].filter(Boolean).join(' · ') : (item.role || item.body || 'Карточка базы знаний');
    const icon = isTimeline ? 'bx-git-commit' : type === 'locations' ? (item.icon || 'bx-map-alt') : (item.icon || 'bx-user');
    const sub = isTimeline && item.subEvents?.length ? `<button class="mini-text-btn" data-action="open-subtimeline" data-parent-id="${escapeHtml(item.id)}">Сабтаймлайн · ${item.subEvents.length}</button>` : '';
    return `
      <article class="mobile-lore-card ${isTimeline ? 'mobile-timeline-card' : ''}" data-lore-type="${escapeHtml(type)}" data-lore-id="${escapeHtml(item.id)}">
        <div class="mobile-lore-main" role="button" tabindex="0" data-lore-type="${escapeHtml(type)}" data-lore-id="${escapeHtml(item.id)}">
          <span class="mobile-lore-icon"><i class="bx ${escapeHtml(icon)}"></i></span>
          <span><strong>${escapeHtml(title || 'Без названия')}</strong><small>${escapeHtml(subtitle || '')}</small></span>
        </div>
        <div class="mobile-lore-actions">
          ${sub}
          <button class="mini-icon-btn" data-action="edit-lore" data-lore-type="${escapeHtml(type)}" data-lore-id="${escapeHtml(item.id)}" aria-label="Редактировать"><i class="bx bx-pencil"></i></button>
        </div>
      </article>`;
  }

  renderMobileLoreDetail(type, item) {
    const title = this.entityDisplayName(item) || (type === 'locations' ? 'Локация' : 'Персонаж');
    const subtitle = type === 'locations' ? 'Карточка локации' : 'Карточка персонажа';
    return `
      <header class="mobile-panel-header">
        <button class="mobile-icon-btn" data-action="mobile-lore-back" aria-label="Назад"><i class="bx bx-left-arrow-alt"></i></button>
        <div><h2>${escapeHtml(title)}</h2><p>${subtitle}</p></div>
        <button class="mobile-icon-btn" data-action="mobile-close-all" aria-label="Закрыть"><i class="bx bx-x"></i></button>
      </header>
      <div class="mobile-panel-body mobile-lore-detail">
        ${this.renderLoreDetail(type, item)}
      </div>`;
  }

  renderMobileSubtimeline(parentId) {
    const parent = this.timelineEvent(parentId);
    if (!parent) {
      this.state.activeSubtimelineId = null;
      return this.renderMobileKb();
    }
    return `
      <header class="mobile-panel-header">
        <button class="mobile-icon-btn" data-action="mobile-subtimeline-back" aria-label="Назад"><i class="bx bx-left-arrow-alt"></i></button>
        <div><h2>${escapeHtml(parent.title || 'Сабтаймлайн')}</h2><p>${parent.subEvents?.length || 0} подсобытий</p></div>
        <button class="mobile-icon-btn" data-action="mobile-close-all" aria-label="Закрыть"><i class="bx bx-x"></i></button>
      </header>
      <div class="mobile-panel-body mobile-subtimeline-screen">
        ${this.renderSubtimelineContent(parent)}
      </div>`;
  }

  renderMobileAi(options = {}) {
    return `
      ${options.asTab ? this.mobileTabHeader('Nocturne AI', this.assistantProviderProblem() || 'Проверка, продолжение и стиль') : this.mobilePanelHeader('Nocturne AI', this.assistantProviderProblem() || 'Проверка, продолжение и стиль')}
      <div class="mobile-panel-body">
        <section class="mobile-ai-hero">${aiIcon('mobile-ai-hero-icon')}<div><strong>Ассистент Nocturne</strong><span>Локальные действия и контекст базы знаний</span></div></section>
        <div class="mobile-ai-grid">
          <button class="ai-card ai-card-primary" data-ai="proofread"><h4><i class="bx bx-check-shield"></i> Корректура</h4><p>Проверить текущий документ.</p></button>
          <button class="ai-card ai-card-primary" data-ai="lore-check"><h4><i class="bx bx-shield-quarter"></i> Проверка лора</h4><p>Сверить с базой знаний.</p></button>
          <button class="ai-card ai-card-secondary" data-ai="continue"><h4><i class="bx bx-brain"></i> Продолжить сцену</h4><p>Продолжить сцену у каретки.</p></button>
          <button class="ai-card ai-card-secondary" data-ai="style"><h4><i class="bx bx-brush"></i> Улучшить стиль</h4><p>Улучшить выделение или абзац.</p></button>
        </div>
        <section class="ai-context-box">
          <div class="ai-context-head"><div><strong>Контекст базы знаний</strong><span>Без вставки в документ</span></div><div class="toggle ${this.state.settings.aiKnowledgeContext ? 'on' : ''}" data-setting="aiKnowledgeContext" data-kind="toggle"></div></div>
          <button class="pill-btn" data-action="preview-ai-context"><i class="bx bx-show"></i> Предпросмотр контекста</button>
          <button class="pill-btn" data-action="mobile-open-ai-settings"><i class="bx bx-cog"></i> Настройки AI</button>
        </section>
        <div class="ai-output mobile-ai-output">${escapeHtml(this.assistantPanelMessage || 'Готов к работе.')}</div>
      </div>`;
  }

  renderMobileNotes() {
    const mode = this.state.mobile.notesMode || this.state.noteMode || 'document';
    const doc = this.getFocusedDoc();
    const text = mode === 'global' ? this.state.globalNotes : (doc?.notes || '');
    return `
      ${this.mobilePanelHeader('Заметки', doc?.title || 'Общие записи')}
      <div class="mobile-panel-body mobile-notes-body">
        <div class="mobile-notes-toolbar">
          <div class="mobile-segmented">
            <button class="${mode === 'document' ? 'active' : ''}" data-mobile-notes-mode="document">Документ</button>
            <button class="${mode === 'global' ? 'active' : ''}" data-mobile-notes-mode="global">Общие</button>
          </div>
          <div class="mobile-panel-actions mobile-notes-actions">
            <button class="pill-btn ai-btn" data-action="mobile-save-notes"><i class="bx bx-save"></i> Сохранить</button>
            <button class="pill-btn" data-action="open-floating-notes-manager"><i class="bx bx-list-ul"></i> Все окна</button>
            <button class="pill-btn" data-action="new-floating-note"><i class="bx bx-note"></i> Новая</button>
          </div>
        </div>
        <textarea class="mobile-notes-editor form-control" data-mobile-notes-input placeholder="Заметки...">${escapeHtml(text)}</textarea>
      </div>`;
  }

  renderMobileExport() {
    const row = (label, note, control) => `<div class="setting-row"><div class="setting-info"><span>${label}</span>${note ? `<small>${note}</small>` : ''}</div><div class="setting-control">${control}</div></div>`;
    const toggle = (key) => `<div class="toggle ${this.state.settings[key] ? 'on' : ''}" data-setting="${key}" data-kind="toggle"></div>`;
    const input = (key, type = 'text') => `<input class="form-control" type="${type}" value="${escapeHtml(this.state.settings[key] || '')}" data-setting="${key}">`;
    return `
      ${this.mobilePanelHeader('Экспорт / резервная копия', 'PDF, DOCX и .nocturnedump')}
      <div class="mobile-panel-body mobile-export-body">${this.exportSettingsContent(row, toggle, input)}</div>`;
  }

  async applyAndroidSystemBars() {
    if (!this.runtime?.isCapacitor && !this.runtime?.isAndroid) return;
    try {
      await window.Capacitor?.Plugins?.StatusBar?.setOverlaysWebView?.({ overlay: true });
      await window.Capacitor?.Plugins?.StatusBar?.hide?.();
      await window.Capacitor?.Plugins?.StatusBar?.setBackgroundColor?.({ color: '#00000000' });
      await window.Capacitor?.Plugins?.StatusBar?.setStyle?.({ style: 'LIGHT' });
    } catch {}
    try {
      await window.Capacitor?.Plugins?.NavigationBar?.setColor?.({ color: '#07070a', darkButtons: false });
      await window.Capacitor?.Plugins?.NavigationBar?.hide?.();
    } catch {}
  }

  startMobileSystemBar() {
    const updateTime = () => {
      this.state.mobile.systemTime = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      document.querySelectorAll('[data-mobile-system-time]').forEach((el) => { el.textContent = this.state.mobile.systemTime; });
    };
    updateTime();
    if (!this.mobileSystemTimer) this.mobileSystemTimer = window.setInterval(updateTime, 30000);
    if (navigator.getBattery && !this.mobileBatteryBound) {
      this.mobileBatteryBound = true;
      navigator.getBattery().then((battery) => {
        const updateBattery = () => {
          this.state.mobile.batteryLevel = Math.round((battery.level || 0) * 100);
          document.querySelectorAll('[data-mobile-battery]').forEach((el) => { el.textContent = `${this.state.mobile.batteryLevel}%`; });
        };
        updateBattery();
        battery.addEventListener?.('levelchange', updateBattery);
      }).catch(() => {});
    }
  }

  async loadRememberedSyncDevices() {
    try {
      this.state.sync.rememberedDevices = (await this.db.getAll('syncDevices'))
        .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    } catch {
      this.state.sync.rememberedDevices = [];
    }
  }

  commandPaletteIconHtml(icon = 'bx-command') {
    if (icon === 'bx-bot') return aiIcon('command-ai-svg');
    const map = {
      'bx-wifi': 'sync',
      'bx-command': 'command',
      'bx-cog': 'settings',
      'bx-file': 'file',
      'bx-file-plus': 'file',
      'bx-file-export': 'export',
      'bx-archive-out': 'export',
      'bx-archive-in': 'export',
      'bx-export': 'export',
      'bx-user': 'user',
      'bx-user-plus': 'user',
      'bx-map-alt': 'location',
      'bx-map-pin': 'location',
      'bx-book-bookmark': 'file',
      'bx-note': 'note',
      'bx-notepad': 'note',
      'bx-git-commit': 'timeline',
      'bx-git-branch': 'timeline',
      'bx-network-chart': 'sync',
      'bx-check-shield': 'trust',
      'bx-spell-check': 'trust',
      'bx-brain': 'ai',
      'bx-brush': 'command',
    };
    return iconSvg(map[icon] || 'command', 'command-ai-svg');
  }

  async connectDiscoveredSyncDevice(id) {
    const device = [...(this.state.sync.discoveredDevices || []), ...(this.state.sync.rememberedDevices || [])]
      .find((item) => String(item.id || item.deviceId || item.publicDeviceId) === String(id));
    if (!device) {
      this.toast('Устройство не найдено.');
      return;
    }
    this.state.sync.host = device.host || device.lastKnownIp || this.state.sync.host;
    this.state.sync.port = String(device.port || device.lastKnownPort || this.state.sync.port || '8787');
    if (!this.state.sync.token) {
      this.state.sync.discovery.manualOpen = true;
      this.toast('Введите код подключения с компьютера.');
      this.renderSyncSurfaces();
      return;
    }
    await this.connectLocalSyncFromUi();
  }

  

  async persistSyncDevice(peer = {}) {
    const id = peer.deviceId || peer.publicDeviceId;
    if (!id) return;
    const previous = await this.db.get('syncDevices', id).catch(() => null);
    const record = {
      ...(previous || {}),
      id,
      deviceId: peer.deviceId || previous?.deviceId || '',
      publicDeviceId: peer.publicDeviceId || previous?.publicDeviceId || '',
      deviceName: peer.deviceName || previous?.deviceName || 'Устройство',
      deviceType: peer.deviceType || peer.runtime || previous?.deviceType || '',
      runtime: peer.runtime || previous?.runtime || '',
      lastKnownIp: this.state.sync.host || previous?.lastKnownIp || '',
      lastKnownPort: this.state.sync.port || previous?.lastKnownPort || '8787',
      discoveryMethod: peer.discoveryMethod || previous?.discoveryMethod || 'manual',
      trusted: peer.trusted !== false,
      autoReconnect: peer.autoReconnect !== false,
      pairingStatus: peer.pairingStatus || 'paired',
      lastSeenAt: Date.now(),
      lastSyncAt: previous?.lastSyncAt || null,
    };
    await this.db.put('syncDevices', record);
      }

  async forgetSyncDevice(id) {
    if (!id) return;
    await this.db.delete('syncDevices', id);
        this.toast('Устройство забыто.');
    this.renderSyncSurfaces();
  }

  async toggleSyncAutoReconnect(id) {
    const record = await this.db.get('syncDevices', id).catch(() => null);
    if (!record) return;
    await this.db.put('syncDevices', { ...record, autoReconnect: !record.autoReconnect });
        this.renderSyncSurfaces();
  }

  async attemptTrustedAutoReconnect() {
    if (this.syncAutoReconnectStarted || this.syncClient.isOpen()) return;
            const device = (this.state.sync.rememberedDevices || []).find((item) => item.trusted && item.autoReconnect && (item.lastKnownIp || item.host));
    if (!device) return;
    this.state.sync.host = device.lastKnownIp || device.host;
    this.state.sync.port = String(device.lastKnownPort || device.port || this.state.sync.port || '8787');
    const token = this.state.sync.token || safeGetStorageItem(localStorage, 'nocturne-sync-token', '');
    if (!token) return;
    try {
      await this.probeSyncDiscoveryHost(this.state.sync.host, this.state.sync.port, 'remembered');
      await this.syncClient.connect({ host: this.state.sync.host, port: this.state.sync.port, token, trusted: true });
      this.state.sync.statusDetail = 'Автоподключение к доверенному устройству...';
    } catch {
      this.state.sync.statusDetail = 'Доверенное устройство сейчас недоступно.';
    }
  }

  async requestSyncMerge() {
    if (!this.syncClient.isOpen()) {
      this.toast('Сначала подключитесь к локальному серверу.');
      return;
    }
    this.state.sync.status = 'syncing';
    this.renderMobileShell();
    await this.sendSyncProjectState();
    this.syncClient.send({ type: 'project-state-request', from: this.state.sync.deviceId });
  }

  async sendSyncProjectState() {
    const dump = await this.buildNocturneDump({ plaintextE2e: false });
    this.syncClient.send({
      type: 'project-state',
      from: this.state.sync.deviceId,
      deviceName: this.state.sync.deviceName,
      dump,
      sentAt: Date.now(),
    });
  }

  async receiveSyncProjectState(message) {
    if (!message?.dump?.payload || message.from === this.state.sync.deviceId) return;
    await this.persistSyncDevice({ deviceId: message.from, deviceName: message.deviceName });
    const preview = this.buildSyncMergePreview(message);
    this.state.sync.remoteState = message;
    this.state.sync.mergePreview = preview;
    this.state.sync.status = 'connected';
    this.state.sync.statusDetail = 'Получен проект. Проверьте preview перед merge.';
    this.renderMobileShell();
  }

  buildSyncMergePreview(message) {
    const payload = message.dump?.payload || {};
    const lore = payload.lore || {};
    const timeline = lore.timeline || [];
    const deviceName = message.deviceName || 'устройство';
    const folderTitle = this.remoteConnectFolderTitle(message);
    const stats = {
      docs: payload.docs?.length || 0,
      folders: payload.folders?.length || 0,
      characters: lore.characters?.length || 0,
      locations: lore.locations?.length || 0,
      timeline: timeline.length,
      subtimelines: timeline.reduce((sum, item) => sum + (item.subEvents?.length || 0), 0),
      notes: payload.floatingNotes?.length || 0,
      conflicts: (payload.docs || []).filter((doc) => this.state.docs.some((local) => local.id === doc.id)).length,
    };
    return {
      remoteDeviceId: message.from,
      remoteDeviceName: deviceName,
      stats,
      connectFolders: [folderTitle],
      receivedAt: Date.now(),
    };
  }

  remoteConnectFolderTitle(message) {
    const name = message.deviceName || 'устройство';
    const source = /android|phone|тел/i.test(name) ? 'С телефона' : 'С компьютера';
    return `${source} — ${name}`;
  }

  async applySyncMergePreview() {
    const remote = this.state.sync.remoteState;
    if (!remote?.dump?.payload) {
      this.toast('Нет подготовленного merge preview.');
      return;
    }
    const report = await this.applyRemoteProjectMerge(remote);
    this.state.sync.mergePreview = null;
    this.state.sync.remoteState = null;
    this.state.sync.status = 'connected';
    this.state.sync.statusDetail = `Объединено: ${report.docs} глав, ${report.characters} персонажей, ${report.locations} локаций.`;
    this.syncClient.send({ type: 'merge-accepted', from: this.state.sync.deviceId, to: remote.from, report });
    this.renderAll();
    this.toast('Локальный merge применён. Настройки не перезаписаны.');
  }

  async applyRemoteProjectMerge(message) {
    const payload = message.dump.payload || {};
    const remoteDeviceId = message.from;
    const folderTitle = this.remoteConnectFolderTitle(message);
    let folder = this.state.folders.find((item) => item.sourceDeviceId === remoteDeviceId && item.syncConnectFolder);
    if (!folder) {
      folder = { id: uid('folder'), title: folderTitle, order: this.state.folders.length, syncConnectFolder: true, sourceDeviceId: remoteDeviceId };
      this.state.folders.push(folder);
      await this.db.put('folders', folder);
    }
    const mappings = await this.db.getAll('syncMappings');
    const mapped = new Map(mappings.filter((item) => item.deviceId === remoteDeviceId).map((item) => [item.remoteDocId, item]));
    const idMap = new Map();
    const report = { docs: 0, characters: 0, locations: 0, timeline: 0, conflicts: 0 };
    for (const remoteDoc of payload.docs || []) {
      if (mapped.has(remoteDoc.id)) {
        idMap.set(remoteDoc.id, mapped.get(remoteDoc.id).localDocId);
        continue;
      }
      const localDoc = this.sanitizeDoc({
        ...structuredClone(remoteDoc),
        id: uid('doc'),
        folderId: folder.id,
        order: this.state.docs.filter((doc) => doc.folderId === folder.id).length,
        sourceDeviceId: remoteDeviceId,
        sourceDocTitle: remoteDoc.title || '',
        syncLinked: true,
        syncRevision: 0,
      });
      idMap.set(remoteDoc.id, localDoc.id);
      this.state.docs.push(localDoc);
      await this.db.put('docs', localDoc);
      const mapping = {
        id: `${remoteDeviceId}:${remoteDoc.id}`,
        deviceId: remoteDeviceId,
        remoteDocId: remoteDoc.id,
        localDocId: localDoc.id,
        sourceFolder: remoteDoc.folderId || '',
        sourceDocTitle: remoteDoc.title || '',
        lastSyncedRevision: 0,
        updatedAt: Date.now(),
      };
      await this.db.put('syncMappings', mapping);
      report.docs += 1;
    }
    const remapDocIds = (ids = []) => ids.map((id) => idMap.get(id) || id);
    const existingChars = new Set(this.state.lore.characters.map((item) => `${remoteDeviceId}:${item.sourceRemoteId || item.id}`));
    const existingLocs = new Set(this.state.lore.locations.map((item) => `${remoteDeviceId}:${item.sourceRemoteId || item.id}`));
    const existingTimes = new Set(this.state.lore.timeline.map((item) => `${remoteDeviceId}:${item.sourceRemoteId || item.id}`));
    for (const item of payload.lore?.characters || []) {
      if (existingChars.has(`${remoteDeviceId}:${item.id}`)) continue;
      this.state.lore.characters.push(this.normalizeCharacter({ ...item, id: uid('char'), sourceRemoteId: item.id, sourceDeviceId: remoteDeviceId, documentIds: remapDocIds(item.documentIds) }, this.state.lore.characters.length));
      report.characters += 1;
    }
    for (const item of payload.lore?.locations || []) {
      if (existingLocs.has(`${remoteDeviceId}:${item.id}`)) continue;
      this.state.lore.locations.push(this.normalizeLocation({ ...item, id: uid('loc'), sourceRemoteId: item.id, sourceDeviceId: remoteDeviceId, documentIds: remapDocIds(item.documentIds) }, this.state.lore.locations.length));
      report.locations += 1;
    }
    for (const item of payload.lore?.timeline || []) {
      if (existingTimes.has(`${remoteDeviceId}:${item.id}`)) continue;
      this.state.lore.timeline.push(this.normalizeTimelineEvent({ ...item, id: uid('time'), sourceRemoteId: item.id, sourceDeviceId: remoteDeviceId, documentIds: remapDocIds(item.documentIds) }, this.state.lore.timeline.length));
      report.timeline += 1;
    }
    const notes = (payload.floatingNotes || []).map((note) => this.sanitizeFloatingNote({ ...note, id: uid('note'), linkedId: idMap.get(note.linkedId) || note.linkedId, sourceDeviceId: remoteDeviceId })).filter(Boolean);
    this.state.floatingNotes.push(...notes);
    await this.saveLore();
    await Promise.all(notes.map((note) => this.db.put('floatingNotes', note)));
    await this.db.put('syncRevisions', { id: remoteDeviceId, deviceId: remoteDeviceId, lastMergedAt: Date.now() });
    return report;
  }

  async receiveSyncMergeAccepted(message = {}) {
    await this.persistSyncDevice({ deviceId: message.from, deviceName: message.deviceName });
    this.state.sync.status = 'connected';
    this.state.sync.statusDetail = 'Второе устройство применило merge preview.';
    this.renderSyncStatus();
    if (this.isMobileLayout()) this.renderMobileShell();
  }



  openAboutModal() {
    const overlay = document.getElementById('form-overlay');
    if (!overlay) return;
    const runtime = this.runtime || detectRuntime();
    overlay.innerHTML = `
      <div class="form-modal about-modal">
        <div class="form-header">
          <div>
            <span class="eyebrow">Nocturne Writer</span>
            <h2>О приложении</h2>
            <p>Локальный редактор рукописей с базой знаний, AI-инструментами и синхронизацией по Wi‑Fi.</p>
          </div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="about-grid">
          <span><small>Режим</small><strong>${escapeHtml(runtime.platform || 'browser')}</strong></span>
          <span><small>Хранилище</small><strong>IndexedDB + localStorage</strong></span>
          <span><small>Документы</small><strong>${this.state.docs.length}</strong></span>
          <span><small>База знаний</small><strong>${this.timelineEventCount() + this.state.lore.characters.length + this.state.lore.locations.length}</strong></span>
                    <span><small>Устройство</small><strong>${escapeHtml(this.state.sync.deviceName || defaultDeviceName(runtime))}</strong></span>
        </div>
        <p class="form-helper">Electron-версия может запускать локальный sync server из приложения. Android подключается к компьютеру по LAN IP и коду подключения.</p>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  async loadSyncMappings() {
    try {
      return await this.db.getAll('syncMappings');
    } catch {
      return [];
    }
  }

  async findSyncMappingByLocalDoc(localDocId) {
    if (!localDocId) return null;
    const mappings = await this.db.getAll('syncMappings');
    return mappings.find(m => m.localDocId === localDocId) || null;
  }

  async findSyncMappingByRemoteDoc(deviceId, remoteDocId) {
    if (!deviceId || !remoteDocId) return null;
    return await this.db.get('syncMappings', `${deviceId}:${remoteDocId}`);
  }

  async updateSyncMappingRevision(mapping, revision) {
    if (!mapping) return;
    await this.db.put('syncMappings', {
      ...mapping,
      lastSyncedRevision: Math.max(Number(mapping.lastSyncedRevision) || 0, Number(revision) || 0),
      updatedAt: Date.now(),
    });
  }

  scheduleSyncForDoc(docId, inputEvent = null) {
    if (!docId) return;
    const type = inputEvent?.inputType || 'typing';
    const data = inputEvent?.data || '';
    const boundary = /\s|[.,!?;:…—-]/u.test(data) || /delete|insertParagraph|insertLineBreak|insertFromPaste/i.test(type);
    this.syncPatchDebounced(docId, boundary ? type : 'typing');
  }

  async queueLiveSyncPatch(docId, reason = 'typing') {
    const mapping = await this.findSyncMappingByLocalDoc(docId);
    if (!mapping) return;
    const doc = this.state.docs.find((item) => item.id === docId);
    if (!doc?.ast?.blocks) return;
    const revId = `local:${docId}`;
    const revState = await this.db.get('syncRevisions', revId) || { id: revId, revision: 0 };
    const revision = (Number(revState.revision) || 0) + 1;
    const blocks = doc.ast.blocks.map((block, index) => ({
      id: block.id,
      type: block.type || 'paragraph',
      html: normalizeHtml(block.html || '<br>'),
      align: block.align || 'left',
      order: index,
    }));
    const patch = {
      type: 'doc-patch',
      deviceId: this.state.sync.deviceId,
      deviceName: this.state.sync.deviceName,
      docId,
      remoteDocId: mapping.remoteDocId,
      mappingId: mapping.id,
      baseRevision: Number(mapping.lastSyncedRevision) || 0,
      revision,
      changedBlocks: blocks,
      deletedBlockIds: [],
      reason,
      timestamp: Date.now(),
      contentHash: await this.checksumText(JSON.stringify(blocks)),
    };
    await this.db.put('syncRevisions', { ...revState, revision, updatedAt: Date.now() });
    if (this.syncClient.isOpen()) {
      this.syncClient.send({ type: 'doc-patch', patch });
      this.state.sync.statusDetail = 'Изменения отправлены на второе устройство.';
      this.renderSyncStatus();
      return;
    }
    await this.db.put('syncQueue', { id: uid('syncq'), kind: 'doc-patch', patch, createdAt: Date.now() });
    this.state.sync.pendingPatches += 1;
    this.renderSyncStatus();
  }

  async flushSyncQueue() {
    if (!this.syncClient.isOpen()) return;
    const queue = await this.db.getAll('syncQueue');
    for (const item of queue) {
      if (item.kind === 'doc-patch' && item.patch) {
        this.syncClient.send({ type: 'doc-patch', patch: item.patch });
        await this.db.delete('syncQueue', item.id);
      }
    }
    this.state.sync.pendingPatches = 0;
    this.renderSyncStatus();
  }

  async receiveSyncPatch(patch = {}) {
    if (!patch.deviceId || patch.deviceId === this.state.sync.deviceId || !patch.docId) return;
    let mapping = await this.findSyncMappingByRemoteDoc(patch.deviceId, patch.docId);
    if (!mapping && patch.remoteDocId && this.state.docs.some((item) => item.id === patch.remoteDocId)) {
      mapping = {
        id: `${patch.deviceId}:${patch.docId}`,
        deviceId: patch.deviceId,
        remoteDocId: patch.docId,
        localDocId: patch.remoteDocId,
        lastSyncedRevision: 0,
      };
    }
    if (!mapping) {
      await this.db.put('syncConflicts', {
        id: uid('conflict'),
        type: 'unmapped-doc-patch',
        deviceId: patch.deviceId,
        remoteDocId: patch.docId,
        patch,
        createdAt: Date.now(),
      });
      this.state.sync.conflicts += 1;
      this.toast('Получен patch для несвязанной главы. Он сохранён как конфликт.');
      return;
    }
    const doc = this.state.docs.find((item) => item.id === mapping.localDocId);
    if (!doc) return;
    const activeBlock = this.currentBlockElement();
    const activeBlockId = activeBlock?.dataset.sourceBlockId || activeBlock?.dataset.blockId;
    const sameDocFocused = doc.id === this.getFocusedDoc()?.id && !!document.activeElement?.closest?.('.page-content');
    const remoteBlockIds = new Set((patch.changedBlocks || []).map((block) => block.id));
    if (sameDocFocused && activeBlockId && remoteBlockIds.has(activeBlockId)) {
      await this.createSyncConflictCopy(doc, patch, mapping);
      this.toast('Конфликт в активном абзаце. Создана безопасная копия.');
      return;
    }
    doc.ast = {
      type: 'doc',
      blocks: (patch.changedBlocks || []).map((block) => ({
        id: block.id || uid('block'),
        type: block.type || 'paragraph',
        html: normalizeHtml(block.html || '<br>'),
        align: block.align || 'left',
      })),
    };
    doc.summary = doc.description || buildSummary(doc.ast);
    doc.updatedAt = Date.now();
    await this.db.put('docs', doc);
    await this.updateSyncMappingRevision(mapping, patch.revision);
    this.state.sync.status = 'connected';
    this.state.sync.statusDetail = `Получены изменения от ${patch.deviceName || 'устройства'}.`;
    if (doc.id === this.getFocusedDoc()?.id && !sameDocFocused) this.renderWorkspace();
    this.renderDocs();
    this.renderMobileTopbarStatus();
  }

  async createSyncConflictCopy(doc, patch, mapping) {
    const copy = this.sanitizeDoc({
      ...structuredClone(doc),
      id: uid('doc'),
      title: `${doc.title || 'Глава'} — конфликт ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      folderId: doc.folderId,
      order: this.state.docs.filter((item) => item.folderId === doc.folderId).length,
      ast: {
        type: 'doc',
        blocks: (patch.changedBlocks || []).map((block) => ({
          id: block.id || uid('block'),
          type: block.type || 'paragraph',
          html: normalizeHtml(block.html || '<br>'),
          align: block.align || 'left',
        })),
      },
      sourceDeviceId: patch.deviceId,
      syncConflict: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.state.docs.push(copy);
    await this.db.put('docs', copy);
    await this.db.put('syncConflicts', {
      id: uid('conflict'),
      type: 'active-block-conflict',
      deviceId: patch.deviceId,
      remoteDocId: patch.docId,
      localDocId: doc.id,
      conflictDocId: copy.id,
      mappingId: mapping?.id || '',
      patch,
      createdAt: Date.now(),
    });
    this.state.sync.status = 'conflict';
    this.state.sync.conflicts += 1;
    this.renderDocs();
    if (this.isMobileLayout()) this.renderMobileShell();
  }

  renderShell() {
    document.getElementById('app').innerHTML = `
      <div class="app-shell ${this.mobileShellClasses()}" id="app-shell">
        ${this.renderMobileSystemBar()}
        ${this.renderMobileTopbar()}
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-header">
            <div class="brand"><span class="brand-logo-img"></span> Nocturne</div>
            <button class="btn-icon" data-action="open-settings" title="Настройки"><i class="bx bx-cog"></i></button>
          </div>
          <div class="docs-container" id="docs-container"></div>
          <div class="sidebar-footer">
            <div class="goal-label"><span>Цель дня</span><span id="goal-count">0 / 0</span></div>
            <div class="goal-track"><div class="goal-fill" id="goal-fill"></div></div>
          </div>
        </aside>
        <main class="main-workspace">
          <header class="toolbar">
            <div class="toolbar-left">
              <div class="dropdown-wrapper" id="kb-dropdown">
                <button class="pill-btn kb-main-btn" data-action="toggle-kb-menu"><i class="bx bx-book-bookmark"></i> <span>База знаний</span> <i class="bx bx-chevron-down"></i></button>
              </div>
              <div class="tool-divider"></div>
              <button class="tool-btn" data-command="undo" title="Отменить"><i class="bx bx-undo"></i></button>
              <button class="tool-btn" data-command="redo" title="Повторить"><i class="bx bx-redo"></i></button>
              <button class="tool-btn" data-action="manual-snapshot" title="Сделать снапшот"><i class="bx bx-camera"></i></button>
              <div class="review-mode-switch" role="group" aria-label="Режим работы">
                <button type="button" data-review-mode="write">Письмо</button>
                <button type="button" data-review-mode="editor">Редактор</button>
                <button type="button" data-review-mode="finalization">Финал</button>
              </div>
              <div class="save-indicator" id="save-indicator" aria-live="polite"></div>
            </div>
            <div class="toolbar-center">
              <div class="review-toolbar-slot" id="review-toolbar-slot"></div>
              <div class="format-dropdown" id="format-dropdown">
                <button class="format-button" data-action="toggle-format-menu"><span id="format-label">Обычный текст</span><i class="bx bx-chevron-down"></i></button>
              </div>
              <button class="tool-btn" data-command="bold" title="Жирный"><i class="bx bx-bold"></i></button>
              <button class="tool-btn" data-command="italic" title="Курсив"><i class="bx bx-italic"></i></button>
              <div class="tool-divider"></div>
              <button class="tool-btn" data-command="justifyLeft" title="По левому краю"><i class="bx bx-align-left"></i></button>
              <button class="tool-btn" data-command="justifyCenter" title="По центру"><i class="bx bx-align-middle"></i></button>
              <button class="tool-btn" data-command="justifyFull" title="По ширине"><i class="bx bx-align-justify"></i></button>
              <div class="tool-divider"></div>
              <div class="search-menu-wrap" id="search-menu-wrap">
                <button class="tool-btn" data-action="toggle-search-menu" title="Поиск и замена"><i class="bx bx-search-alt"></i></button>
              </div>
              <button class="tool-btn" data-action="open-command-palette" title="Палитра команд — Ctrl+K" aria-label="Палитра команд"><i class="bx bx-command"></i></button>
            </div>
            <div class="toolbar-right">
              <div class="split-menu-wrap" id="split-menu-wrap">
                <button class="tool-btn" data-action="toggle-split-menu" title="Split-screen"><i class="bx bx-sidebar"></i></button>
              </div>
              <div class="floating-note-menu-wrap" id="floating-note-menu-wrap">
                <button class="tool-btn" data-action="toggle-floating-note-menu" data-floating-note-menu-anchor title="Плавающие заметки"><i class="bx bx-note"></i></button>
              </div>
                            <button class="tool-btn toolbar-settings-btn" data-action="open-settings" title="Настройки" aria-label="Настройки"><i class="bx bx-cog"></i></button>
              ${this.state.settings.showZenButton ? '<button class="tool-btn zen-toggle-btn" data-action="toggle-zen" aria-pressed="false" title="Режим Дзен"><i class="bx bx-target-lock"></i></button>' : ''}
              <button class="pill-btn" data-action="toggle-notes"><i class="bx bx-notepad"></i> <span>Заметки</span></button>
              <button class="pill-btn" data-action="import-doc"><i class="bx bx-import"></i> <span>Импорт</span></button>
              <button class="pill-btn ai-btn" data-action="toggle-ai">${aiIcon('toolbar-ai-svg')} <span>Ассистент</span></button>
              <input id="import-input" type="file" accept=".txt,.md,.html,.htm,.docx,.pdf,.nocturned,.nocturnedump,application/json" multiple hidden>
            </div>
          </header>
          <div class="workspace-stage" id="workspace-stage" data-mode="single">
            <section class="workspace-pane primary-pane active-pane" data-pane-id="primary"></section>
            <div class="workspace-divider" id="workspace-divider" data-action="resize-workspace"></div>
            <section class="workspace-pane secondary-pane" data-pane-id="secondary"></section>
          </div>
          <aside class="side-panel" id="ai-panel">
            <div class="panel-header">
              <div class="panel-title">${aiIcon('panel-ai-svg')} Nocturne AI</div>
              <button class="btn-icon" data-action="close-ai"><i class="bx bx-x"></i></button>
            </div>
            <div class="panel-content">
              <button class="ai-card ai-card-primary" data-ai="proofread"><h4><i class="bx bx-check-shield"></i> Проверить текст</h4><p>Ищет орфографические, пунктуационные, грамматические и стилистические проблемы, затем показывает их прямо в тексте.</p></button>
              <button class="ai-card ai-card-primary" data-ai="lore-check"><h4><i class="bx bx-shield-quarter"></i> Проверить лор</h4><p>Сравнивает фрагмент или документ с Базой знаний и отмечает возможные противоречия.</p></button>
              <div class="ai-tool-section-title">Творческие инструменты</div>
              <button class="ai-card ai-card-secondary" data-ai="continue"><h4><i class="bx bx-brain"></i> Продолжить фрагмент</h4><p>Продолжает текущую фразу или сцену с учетом позиции каретки.</p></button>
              <button class="ai-card ai-card-secondary" data-ai="style"><h4><i class="bx bx-brush"></i> Улучшить стиль</h4><p>Переписывает текущий абзац или выделение с учетом выбранной персоны редактора.</p></button>
              <button class="ai-card ai-card-secondary" data-ai="sentiment"><h4><i class="bx bx-line-chart"></i> Тональность сцены</h4><p>Строит эмоциональную кривую текущей главы локальным анализатором.</p></button>
              <section class="ai-context-box">
                <div class="ai-context-head">
                  <div><strong>Контекст базы знаний</strong><span id="ai-context-budget">KB: off</span></div>
                  <div class="toggle ${this.state.settings.aiKnowledgeContext ? 'on' : ''}" data-setting="aiKnowledgeContext" data-kind="toggle"></div>
                </div>
                <div class="ai-context-toggles">
                  ${[
                    ['aiContextCharacters', 'Персонажи'],
                    ['aiContextLocations', 'Локации'],
                    ['aiContextTimeline', 'Таймлайн'],
                    ['aiContextSubtimelines', 'Сабтаймлайны'],
                    ['aiContextNotes', 'Заметки'],
                  ].map(([key, label]) => `<button class="context-chip ${this.state.settings[key] ? 'active' : ''}" data-setting="${key}" data-kind="toggle">${label}</button>`).join('')}
                </div>
                <button class="pill-btn" data-action="preview-ai-context"><i class="bx bx-show"></i> Предпросмотр контекста</button>
              </section>
              <div class="ai-output" id="ai-output">Готов к работе.</div>
              <canvas class="sentiment-graph" id="sentiment-graph" width="320" height="52"></canvas>
            </div>
          </aside>
          <aside class="side-panel" id="notes-panel">
            <div class="panel-header">
              <div class="panel-title"><i class="bx bx-notepad"></i> Заметки к документу</div>
              <button class="btn-icon" data-action="close-notes"><i class="bx bx-x"></i></button>
            </div>
            <div class="notes-tabs">
              <button class="notes-tab active" data-notes-mode="document">Документ</button>
              <button class="notes-tab" data-notes-mode="global">Общие</button>
            </div>
            <div class="notes-tools">
              <button class="tool-btn" data-action="note-divider" title="Разделитель"><i class="bx bx-minus"></i></button>
              <button class="tool-btn" data-action="note-checklist" title="Чек-лист"><i class="bx bx-check-square"></i></button>
              <button class="tool-btn" data-action="note-toggle-check" title="Переключить пункт"><i class="bx bx-check"></i></button>
              <button class="tool-btn" data-action="note-heading" title="Заголовок"><i class="bx bx-heading"></i></button>
              <button class="tool-btn" data-action="new-floating-note" title="Новая плавающая заметка"><i class="bx bx-note"></i></button>
            </div>
            <div class="floating-notes-manager" id="floating-notes-manager"></div>
            <div contenteditable="true" class="notes-textarea" id="notes-input" placeholder="Ваши быстрые идеи..."></div>
          </aside>
        </main>
        ${this.renderMobileTabSurface()}
        ${this.renderMobileBottomNav()}
      </div>
      ${this.renderMobileOverlay()}
      <div class="floating-notes-layer" id="floating-notes-layer"></div>
      <div class="floating-notes-modal" id="floating-notes-modal"></div>
      <div class="floating-menu-portal" id="floating-menu-portal" aria-hidden="true">
        <div class="dropdown-menu popover-surface portal-floating-menu" id="kb-menu" data-floating-menu="kb" aria-hidden="true">
          <div class="drop-item kb-drop-row" data-kb-open="characters"><i class="bx bx-user-pin"></i><span>Персонажи</span><button type="button" data-action="open-kb-right" data-kb-tab="characters" title="Открыть справа"><i class="bx bx-sidebar"></i></button></div>
          <div class="drop-item kb-drop-row" data-kb-open="locations"><i class="bx bx-map-alt"></i><span>Локации</span><button type="button" data-action="open-kb-right" data-kb-tab="locations" title="Открыть справа"><i class="bx bx-sidebar"></i></button></div>
          <div class="drop-item kb-drop-row" data-kb-open="timeline"><i class="bx bx-git-commit"></i><span>Таймлайн</span><button type="button" data-action="open-kb-right" data-kb-tab="timeline" title="Открыть справа"><i class="bx bx-sidebar"></i></button></div>
          <div class="drop-item kb-drop-row" data-kb-open="notes"><i class="bx bx-note"></i><span>Записи</span><button type="button" data-action="open-kb-right" data-kb-tab="notes" title="Открыть справа"><i class="bx bx-sidebar"></i></button></div>
        </div>
        <div class="format-menu popover-surface portal-floating-menu" id="format-menu" data-floating-menu="format" aria-hidden="true">
          <button data-format-block="paragraph"><i class="bx bx-text"></i><span>Обычный текст</span></button>
          <button data-format-block="heading"><i class="bx bx-heading"></i><span>Заголовок</span></button>
          <button data-format-block="quote"><i class="bx bxs-quote-left"></i><span>Цитата</span></button>
        </div>
        <div class="search-menu popover-surface portal-floating-menu" id="search-menu" data-floating-menu="search" aria-hidden="true">
          <button class="floating-menu-item search-menu-item" data-action="open-search-chooser">
            <i class="bx bx-search"></i>
            <span>Поиск<small>Найти слова и фразы в документе или проекте</small></span>
          </button>
          <button class="floating-menu-item search-menu-item" data-action="open-replace-window">
            <i class="bx bx-transfer"></i>
            <span>Замена<small>Найти фрагмент и аккуратно заменить его в документе</small></span>
          </button>
        </div>
        <div class="split-menu popover-surface portal-floating-menu" id="split-menu" data-floating-menu="split" aria-hidden="true">
          <button class="floating-menu-item split-menu-item" data-action="split-empty-right">
            <i class="bx bx-dock-right"></i>
            <span>Пустая область справа<small>Открыть вторую рабочую область справа</small></span>
          </button>
          <button class="floating-menu-item split-menu-item" data-action="split-empty-left">
            <i class="bx bx-dock-left"></i>
            <span>Пустая область слева<small>Открыть вторую рабочую область слева</small></span>
          </button>
          <button class="floating-menu-item split-menu-item split-close-option" data-action="close-secondary-pane">
            <i class="bx bx-collapse-horizontal"></i>
            <span>Закрыть split-screen<small>Вернуться к одной рабочей области</small></span>
          </button>
        </div>
        <div class="floating-note-popover popover-surface portal-floating-menu" id="floating-note-popover" data-floating-menu="notes" aria-hidden="true"></div>
        <div class="review-issue-menu popover-surface portal-floating-menu" id="review-issue-menu" data-floating-menu="review" aria-hidden="true">
          <button data-action="quick-review-issue" data-review-category="orthography"><i class="bx bx-check-circle"></i>Орфография</button>
          <button data-action="quick-review-issue" data-review-category="logic"><i class="bx bx-brain"></i>Логика</button>
          <button data-action="quick-review-issue" data-review-category="plot"><i class="bx bx-git-branch"></i>Сюжет / мотивация</button>
          <button data-action="quick-review-issue" data-review-category="continuity"><i class="bx bx-bookmark"></i>Лор / непрерывность</button>
          <button data-action="quick-review-issue" data-review-category="style"><i class="bx bx-water"></i>Стиль / ритм</button>
        </div>
      </div>
      <div class="doc-menu-portal" id="doc-menu-portal" aria-hidden="true"></div>
      <div class="kb-modal" id="kb-modal"></div>
      <div class="modal-overlay" id="settings-overlay"></div>
      <div class="modal-overlay" id="form-overlay"></div>
      <div class="command-palette-overlay" id="command-palette-overlay" aria-hidden="true"></div>
      <div class="modal-overlay" id="shortcuts-overlay"></div>
      <div class="suggestion-bar" id="suggestion-bar">
        <button class="pill-btn ai-btn" data-action="accept-ai"><i class="bx bx-check"></i> Принять</button>
        <button class="pill-btn" data-action="reject-ai"><i class="bx bx-x"></i> Отклонить</button>
      </div>
      <div class="custom-caret" id="custom-caret"></div>
      <div class="entity-hover-card" id="entity-hover-card" aria-hidden="true"></div>
      <div class="entity-hover-card entity-preview-card" id="entity-preview-card" aria-hidden="true"></div>
      <div class="app-context-menu popover-surface" id="app-context-menu" aria-hidden="true"></div>
      <div class="doc-search-panel popover-surface" id="doc-search-panel" aria-hidden="true"></div>
      <div class="search-navigator" id="search-navigator" aria-hidden="true"></div>
      <div class="review-navigator" id="review-navigator" aria-hidden="true"></div>
      <div class="settings-help-tooltip" id="settings-help-tooltip" aria-hidden="true"></div>
      <div class="toast" id="toast"></div>
      <canvas id="anim-canvas" style="position:fixed; top:0; left:0; pointer-events:none; z-index:9998;"></canvas>
      <div id="docs-dnd-overlay" aria-hidden="true"><i class="bx bx-cloud-download"></i>Перетащите файлы для импорта</div>
    `;
    const oldFloatingPortals = Array.from(document.querySelectorAll('#floating-menu-portal'));
    oldFloatingPortals.slice(1).forEach((portal) => portal.remove());
    const floatingPortal = document.getElementById('floating-menu-portal');
    if (floatingPortal?.parentElement !== document.body) document.body.appendChild(floatingPortal);
    const docPortal = document.getElementById('doc-menu-portal');
    if (docPortal?.parentElement !== document.body) document.body.appendChild(docPortal);
    this.updateRuntimeClasses();
    this.renderMobileTopbarStatus();
  }

  startPreloader() {
    const particles = document.getElementById('particles-container');
    if (particles) {
      particles.innerHTML = '';
      for (let i = 0; i < 50; i += 1) {
        const p = document.createElement('div');
        p.className = 'particle';
        const size = Math.random() * 3 + 1;
        p.style.left = `${Math.random() * 100}vw`;
        p.style.width = `${size}px`;
        p.style.height = `${size}px`;
        p.style.animationDelay = `${Math.random() * 2}s`;
        p.style.animationDuration = `${Math.random() * 3 + 2}s`;
        particles.appendChild(p);
      }
    }
    const progressFill = document.querySelector('.preloader-progress-fill');
    if (progressFill) {
      progressFill.style.transition = 'width 1500ms cubic-bezier(0.22, 1, 0.36, 1)';
      progressFill.style.width = '100%';
    }
    setTimeout(() => {
      const preloader = document.getElementById('preloader');
      if (preloader) preloader.classList.add('hidden');
      const appShell = document.getElementById('app-shell');
      if (appShell) appShell.classList.add('ready');
      if (!this.isMobileLayout()) document.querySelector('.page-content')?.focus();
    }, 1800);
  }

  renderAll() {
    this.renderDocs();
    this.renderWorkspace();
    this.renderNotes();
    this.renderFloatingNotes();
    this.renderFloatingNoteMenu();
    this.renderFloatingNotesModal();
    this.renderKb();
    this.renderSettings();
    this.applyReviewMode();
    this.renderSaveIndicator();
    this.renderReviewToolbarSlot();
    this.renderReviewNavigator();
    this.updateReviewHighlights();
    this.renderGoal();
    this.drawSentiment();
    this.updateAssistantPanelState();
    this.updateSplitMenuState();
    this.renderMobileShell();
  }

  renderMobileShell() {
    this.updateRuntimeClasses();
    const activeMobileField = document.activeElement?.matches?.('[data-mobile-doc-search], [data-mobile-lore-search], [data-mobile-notes-input]')
      ? {
        selector: document.activeElement.matches('[data-mobile-doc-search]') ? '[data-mobile-doc-search]' : document.activeElement.matches('[data-mobile-lore-search]') ? '[data-mobile-lore-search]' : '[data-mobile-notes-input]',
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd,
      }
      : null;
    const topbar = document.querySelector('.mobile-topbar');
    const nextTopbar = this.renderMobileTopbar();
    if (topbar && topbar.outerHTML !== nextTopbar) topbar.outerHTML = nextTopbar;
    const systemBar = document.querySelector('.mobile-system-bar');
    const nextSystemBar = this.renderMobileSystemBar();
    if (systemBar && systemBar.outerHTML !== nextSystemBar) systemBar.outerHTML = nextSystemBar;
    const nav = document.querySelector('.mobile-bottom-nav');
    const nextNav = this.renderMobileBottomNav();
    if (nav && nav.outerHTML !== nextNav) nav.outerHTML = nextNav;
    const tabSurface = document.getElementById('mobile-tab-surface');
    const nextTabSurface = this.renderMobileTabSurface();
    if (tabSurface && tabSurface.outerHTML !== nextTabSurface) {
      tabSurface.outerHTML = nextTabSurface;
      this.setupMobileKbSortables();
    }
    const overlay = document.getElementById('mobile-overlay');
    if (overlay) {
      const panelMode = this.mobilePanelMode();
      overlay.classList.toggle('active', !!this.state.mobile.panel);
      overlay.classList.remove('mobile-overlay-screen', 'mobile-overlay-sheet', 'mobile-overlay-fullscreen');
      overlay.classList.add(`mobile-overlay-${panelMode}`);
      overlay.setAttribute('aria-hidden', this.state.mobile.panel ? 'false' : 'true');
      const panel = document.getElementById('mobile-panel');
      if (panel) {
        panel.classList.remove('mobile-panel-screen', 'mobile-panel-sheet', 'mobile-panel-fullscreen');
        panel.classList.add(`mobile-panel-${panelMode}`);
        panel.innerHTML = this.renderMobilePanel();
        this.setupMobileKbSortables();
      }
    }
    this.renderMobileTopbarStatus();
    this.updateRangeControls();
    if (activeMobileField) {
      requestAnimationFrame(() => {
        const field = document.querySelector(activeMobileField.selector);
        field?.focus();
        if (Number.isFinite(activeMobileField.start)) field?.setSelectionRange(activeMobileField.start, activeMobileField.end);
      });
    }
  }

  mobileRouteSnapshot() {
    return {
      panel: this.state.mobile.panel,
      activeTab: this.state.mobile.activeTab,
      settingsTab: this.state.mobile.settingsTab,
      kbTab: this.state.mobile.kbTab,
      activeLoreDetail: this.state.activeLoreDetail ? { ...this.state.activeLoreDetail } : null,
      activeSubtimelineId: this.state.activeSubtimelineId,
    };
  }

  mobileCanGoBack() {
    return !!(this.state.mobile.routeStack?.length || this.state.mobile.settingsTab || this.state.activeLoreDetail || this.state.activeSubtimelineId);
  }

  restoreMobileRoute(route) {
    if (!route) return false;
    this.state.mobile.panel = route.panel || null;
    this.state.mobile.activeTab = route.activeTab || 'write';
    this.state.mobile.settingsTab = route.settingsTab || null;
    this.state.mobile.kbTab = route.kbTab || this.state.mobile.kbTab || 'characters';
    this.state.activeLoreDetail = route.activeLoreDetail || null;
    this.state.activeSubtimelineId = route.activeSubtimelineId || null;
    this.renderMobileShell();
    return true;
  }

  pushMobileRoute(route = this.mobileRouteSnapshot()) {
    if (!route.panel && !route.activeLoreDetail && !route.activeSubtimelineId && !route.settingsTab) return;
    const stack = Array.isArray(this.state.mobile.routeStack) ? this.state.mobile.routeStack : [];
    const last = stack.at(-1);
    if (last && JSON.stringify(last) === JSON.stringify(route)) return;
    stack.push(route);
    this.state.mobile.routeStack = stack.slice(-12);
  }

  switchMobileTab(tab = 'write', options = {}) {
    const valid = ['write', 'docs', 'lore', 'ai', 'more'];
    if (!valid.includes(tab)) return;
    const current = this.state.mobile.activeTab || 'write';
    const order = new Map(valid.map((item, index) => [item, index]));
    this.state.mobile.previousTab = current;
    this.state.mobile.tabDirection = (order.get(tab) ?? 0) >= (order.get(current) ?? 0) ? 1 : -1;
    this.state.mobile.activeTab = tab;
    if (!options.keepOverlay) this.state.mobile.panel = null;
    this.state.mobile.routeStack = [];
    if (tab !== 'lore') {
      this.state.activeLoreDetail = null;
      this.state.activeSubtimelineId = null;
    }
    if (tab !== 'more') this.state.mobile.settingsTab = null;
    this.closeAllFloatingMenus();
    this.renderMobileShell();
  }

  openMobilePanel(panelName, activeTab = null, options = {}) {
    if (!panelName) return;
    const { replace = false, resetDetail = true } = options;
    if (replace) this.state.mobile.routeStack = [];
    else this.pushMobileRoute();
    this.state.mobile.previousPanel = this.state.mobile.panel;
    this.state.mobile.panel = panelName;
    this.state.mobile.panelMode = this.mobilePanelMode(panelName);
    if (activeTab) this.state.mobile.activeTab = activeTab;
    else if (['docs', 'lore', 'ai', 'more'].includes(panelName)) this.state.mobile.activeTab = panelName === 'lore' ? 'lore' : panelName;
    if (resetDetail && panelName !== 'settings') this.state.mobile.settingsTab = null;
    if (resetDetail && panelName !== 'lore') {
      this.state.activeLoreDetail = null;
      this.state.activeSubtimelineId = null;
    }
    this.closeAllFloatingMenus();
    this.renderMobileShell();
  }

  closeMobilePanel(options = {}) {
    const { restore = true } = options;
    if (restore && this.state.mobile.routeStack?.length) {
      const route = this.state.mobile.routeStack.pop();
      this.restoreMobileRoute(route);
      return;
    }
    this.state.mobile.panel = null;
    this.state.mobile.settingsTab = null;
    this.state.activeLoreDetail = null;
    this.state.activeSubtimelineId = null;
    if (this.state.mobile.activeTab !== 'write') this.state.mobile.activeTab = 'write';
    this.renderMobileShell();
  }

  closeMobileToEditor() {
    this.state.mobile.panel = null;
    this.state.mobile.previousPanel = null;
    this.state.mobile.routeStack = [];
    this.state.mobile.settingsTab = null;
    this.state.mobile.activeTab = 'write';
    this.state.activeLoreDetail = null;
    this.state.activeSubtimelineId = null;
    this.renderMobileShell();
  }

  mobileBack() {
    if (this.state.mobile.settingsTab) {
      this.state.mobile.settingsTab = null;
      this.renderMobileShell();
      return true;
    }
    if (this.state.activeSubtimelineId) {
      this.state.activeSubtimelineId = null;
      this.renderMobileShell();
      return true;
    }
    if (this.state.activeLoreDetail) {
      this.state.activeLoreDetail = null;
      this.renderMobileShell();
      return true;
    }
    if (this.state.mobile.routeStack?.length) {
      const route = this.state.mobile.routeStack.pop();
      return this.restoreMobileRoute(route);
    }
    if (this.state.mobile.panel) {
      this.closeMobileToEditor();
      return true;
    }
    if ((this.state.mobile.activeTab || 'write') !== 'write') {
      this.switchMobileTab('write');
      return true;
    }
    return false;
  }

  bindGlobalEvents() {
    document.addEventListener('click', (event) => this.handleClick(event));
    document.addEventListener('pointerdown', (event) => this.handleGlobalPointerDownCapture(event), true);
    document.addEventListener('pointerdown', (event) => this.handleMobileEditorSelectionPointerDown(event), { capture: true, passive: false });
    document.addEventListener('pointermove', (event) => this.handleMobileEditorSelectionPointerMove(event), { capture: true, passive: false });
    document.addEventListener('pointerup', (event) => this.handleMobileEditorSelectionPointerUp(event), true);
    document.addEventListener('touchstart', (event) => this.handleFormatBarPress(event), { capture: true, passive: false });
    document.addEventListener('pointerup', (event) => this.handleFormatBarPointerUp(event), true);
    document.addEventListener('pointerup', (event) => this.handleDocPointerUpCapture(event), true);
    document.addEventListener('beforeinput', (event) => this.handleBeforeInput(event));
    document.addEventListener('input', (event) => this.handleInput(event));
    document.addEventListener('compositionstart', () => { this.isComposing = true; });
    document.addEventListener('compositionend', (event) => {
      this.isComposing = false;
      const editable = document.activeElement?.closest('.page-content');
      if (this.nocturneEditor?.getByElement(editable)) return;
      if (editable) {
        this.editorInput(editable, event);
      }
    });
    document.addEventListener('focusout', (event) => this.handleFocusOut(event));
    document.addEventListener('focusin', () => this.handleMobileViewportChange());
    document.addEventListener('change', (event) => this.handleChange(event));
    document.addEventListener('paste', (event) => this.handlePaste(event));
    document.addEventListener('contextmenu', (event) => this.handleContextMenu(event));
    document.addEventListener('dblclick', (event) => this.handleDoubleClick(event));
    document.addEventListener('keydown', (event) => this.handleKeydown(event));
    document.addEventListener('keyup', (event) => this.handleKeyup(event));
    window.addEventListener('blur', () => {
      this.currentlyPressedKeys = this.currentlyPressedKeys || new Set();
      this.currentlyPressedKeys.clear();
    });
    document.addEventListener('pointerdown', (event) => this.handlePointerDown(event));
    document.addEventListener('mouseover', (event) => this.handleEntityMouseOver(event));
    document.addEventListener('mousemove', (event) => this.handleEntityMouseMove(event));
    document.addEventListener('mouseout', (event) => this.handleEntityMouseOut(event));
    document.addEventListener('mouseover', (event) => this.handleFloatingNoteMenuMouseOver(event));
    document.addEventListener('mouseout', (event) => this.handleFloatingNoteMenuMouseOut(event));
    document.addEventListener('pointermove', (event) => this.handleDocPaneDragMove(event), true);
    document.addEventListener('pointerup', (event) => this.handleDocPaneDragEnd(event), true);
    document.addEventListener('mouseover', (event) => this.handleSettingsTooltipEnter(event));
    document.addEventListener('mouseout', (event) => this.handleSettingsTooltipLeave(event));
    document.addEventListener('focusin', (event) => this.handleSettingsTooltipEnter(event));
    document.addEventListener('focusout', (event) => this.handleSettingsTooltipLeave(event));
    document.addEventListener('selectionchange', () => {
      this.captureSelectionSnapshot();
      this.updateEditorSelectionState();
      this.renderNocturneSelectionLayer();
      this.updateCustomCaret();
      this.updateActiveBlock();
      
      this.updateToolbarState();
      this.renderReviewToolbarSlot();
    });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
          if (pane.type === 'document' && pane.docId) this.writeLiveDraft(pane.docId);
        });
        this.saveActiveDoc({ silent: true, forceSync: true });
      }
    });
    window.addEventListener('beforeunload', () => {
      Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
        if (pane.type === 'document' && pane.docId) this.writeLiveDraft(pane.docId);
      });
      this.saveActiveDoc({ silent: true, forceSync: true });
    });
    window.addEventListener('resize', () => {
      this.renderNocturneSelectionLayer();
      this.updateActiveFloatingMenuPosition();
      this.closeContextMenu();
      this.closeDocContextMenu();
      this.mobileResizeDebounced();
    });
    window.addEventListener('scroll', () => {
      if (this.selectionController?.active || this.state.editorSelection?.active) {
        requestAnimationFrame(() => this.renderNocturneSelectionLayer());
      }
    }, { passive: true, capture: true });
    window.addEventListener('orientationchange', () => {
      this.renderNocturneSelectionLayer();
      this.mobileResizeDebounced();
    });
    window.visualViewport?.addEventListener('resize', () => this.mobileResizeDebounced());
    window.visualViewport?.addEventListener('scroll', () => this.mobileResizeDebounced());
    this.bindCapacitorBackButton();
    document.getElementById('workspace-stage').addEventListener('scroll', () => {
      this.renderNocturneSelectionLayer();
      this.updateCustomCaret();
      this.hideEntityHoverCards();
      this.updateActiveFloatingMenuPosition();
      this.closeContextMenu();
      this.closeDocContextMenu();
    }, true);
    document.getElementById('docs-container')?.addEventListener('scroll', () => this.closeDocContextMenu(), true);

    // DOCX / KB file drag-and-drop import (Item 12)
    let _docsDragCounter = 0;
    const _dndOverlay = document.getElementById('docs-dnd-overlay');
    document.addEventListener('dragenter', (e) => {
      if (document.getElementById('kb-modal')?.classList.contains('active')) return;
      if (!e.dataTransfer?.types?.includes('Files')) return;
      _docsDragCounter++;
      _dndOverlay?.classList.add('active');
    });
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) { _docsDragCounter = 0; _dndOverlay?.classList.remove('active'); }
    });
    document.addEventListener('dragover', (e) => {
      if (document.getElementById('kb-modal')?.classList.contains('active')) return;
      e.preventDefault();
    });
    document.addEventListener('drop', async (e) => {
      if (document.getElementById('kb-modal')?.classList.contains('active')) return;
      _docsDragCounter = 0;
      _dndOverlay?.classList.remove('active');
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      const supportedExts = ['.docx', '.pdf', '.txt', '.md', '.html', '.htm', '.nocturned', '.nocturnedump', '.nocturnmemory', '.nocturnechar', '.nocturneplace', '.nocturnetime', '.nocturnenote', '.nocturnecharacters', '.nocturneplaces', '.nocturnetimelines', '.nocturnenotes'];
      const droppedFiles = Array.from(files).filter(f => supportedExts.some(ext => f.name.toLowerCase().endsWith(ext)));
      if (droppedFiles.length) {
        e.preventDefault();
        await this.importDocuments(droppedFiles);
      }
    });
  }

  bindCapacitorBackButton() {
    const appPlugin = window.Capacitor?.Plugins?.App;
    if (!appPlugin?.addListener || this.capacitorBackBound) return;
    this.capacitorBackBound = true;
    appPlugin.addListener('backButton', ({ canGoBack } = {}) => {
      if (this.closeTopMobileOverlay()) return;
      if (canGoBack) window.history.back();
      else this.openExitSheet();
    });
  }

  blurMobileEditorFocus() {
    const active = document.activeElement;
    const wasContentEditable = !!active?.isContentEditable;
    const previousEditable = wasContentEditable ? active.getAttribute('contenteditable') : null;
    if (wasContentEditable) active.setAttribute('contenteditable', 'false');
    active?.blur?.();
    if (active && document.activeElement === active) {
      let focusTrap = document.getElementById('mobile-focus-sentinel');
      if (!focusTrap) {
        focusTrap = document.createElement('button');
        focusTrap.id = 'mobile-focus-sentinel';
        focusTrap.type = 'button';
        focusTrap.tabIndex = -1;
        focusTrap.setAttribute('aria-hidden', 'true');
        focusTrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
        document.body.appendChild(focusTrap);
      }
      focusTrap.focus({ preventScroll: true });
    }
    if (wasContentEditable) {
      requestAnimationFrame(() => active.setAttribute('contenteditable', previousEditable ?? 'true'));
    }
    this.state.mobile.editorFocused = false;
    this.state.mobile.keyboardOpen = false;
    this.updateRuntimeClasses();
  }

  closeTopMobileOverlay() {
    if (this.activeFloatingMenuKey || document.querySelector('.portal-floating-menu.active, #doc-menu-portal.open, #app-context-menu.active')) {
      this.closeAllFloatingMenus();
      this.closeContextMenu();
      this.closeDocContextMenu();
      return true;
    }
    if (this.commandPalette?.opened) {
      this.commandPalette.close({ restoreFocus: false });
      return true;
    }
    const activeModal = document.querySelector('#form-overlay.active, #settings-overlay.active, #kb-modal.active, #shortcuts-overlay.active, .floating-notes-modal.active');
    if (activeModal) {
      activeModal.classList.remove('active');
      return true;
    }
    if (this.isMobileLayout() && this.mobileBack()) return true;
    const openSidePanel = document.querySelector('.side-panel.open');
    if (openSidePanel) {
      openSidePanel.classList.remove('open');
      return true;
    }
    const focused = document.activeElement?.closest?.('.page-content, input, textarea, [contenteditable="true"]');
    if (focused && this.isMobileLayout()) {
      this.blurMobileEditorFocus();
      return true;
    }
    return false;
  }

  openExitSheet() {
    const overlay = document.getElementById('form-overlay');
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="form-modal confirm-modal mobile-exit-sheet">
        <div class="confirm-icon"><i class="bx bx-log-out"></i></div>
        <h2>Выйти из Nocturne?</h2>
        <p>Все локальные изменения сохраняются автоматически. Можно остаться в редакторе или свернуть приложение.</p>
        <div class="form-actions">
          <button class="pill-btn ai-btn" data-close-form>Остаться</button>
          <button class="pill-btn" data-action="mobile-background-app">Свернуть</button>
        </div>
      </div>`;
    overlay.classList.add('active');
  }

  handleClick(event) {
    if (this.isMobileLayout?.() && event.target.closest?.('.mobile-format-bar')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.id === 'mobile-overlay') {
      if (this.state.mobile.panel === 'actions') this.closeMobilePanel();
      return;
    }
    const commandRun = event.target.closest?.('[data-command-palette-run]');
    if (commandRun) {
      this.commandPalette.run(commandRun.dataset.commandPaletteRun);
      return;
    }
    if (event.target.id === 'command-palette-overlay') {
      this.commandPalette.close();
      return;
    }
    const entitySurface = event.target.closest?.('.entity-link, #entity-hover-card, #entity-preview-card');
    if (!entitySurface) this.hideEntityHoverCards();
    const settingsSelect = event.target.closest?.('.nocturne-select');
    if (!settingsSelect) this.closeSettingsSelects();
    const settingsSelectToggle = event.target.closest?.('[data-setting-select-toggle]');
    if (settingsSelectToggle) {
      this.toggleSettingsSelect(settingsSelectToggle.closest('.nocturne-select'));
      return;
    }
    const settingsSelectOption = event.target.closest?.('[data-setting-option]');
    if (settingsSelectOption) {
      this.updateSettingFromCustomOption(settingsSelectOption);
      return;
    }
    const insideFloatingMenu = event.target.closest?.('#floating-menu-portal, #floating-note-menu-wrap, #split-menu-wrap, #kb-dropdown, #format-dropdown, #search-menu-wrap, .review-issue-dropdown, #app-context-menu, #doc-search-panel, #search-navigator, .doc-context-menu, .doc-menu-btn');
    if (!insideFloatingMenu) {
      this.closeAllFloatingMenus();
    }
    const clickedPane = event.target.closest?.('[data-pane-id]')?.dataset.paneId;
    if (clickedPane) this.setFocusedPane(clickedPane);

    const pageEl = event.target.closest('.page');
    if (pageEl && !event.target.closest('.ProseMirror, button, input, textarea, select, .entity-link, .floating-note, .context-menu, .doc-menu-btn')) {
      const paneId = pageEl.dataset.paneId || pageEl.closest('[data-pane-id]')?.dataset.paneId;
      if (paneId) {
        const editor = this.nocturneEditor?.get(paneId);
        if (editor) {
          editor.commands.focus();
        }
      }
    }
    const entityLink = event.target.closest?.('.entity-link');
    if (entityLink && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.openEntityLinkDetail(entityLink);
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    const reviewModeButton = event.target.closest('button[data-review-mode]');
    if (reviewModeButton) {
      this.setReviewMode(reviewModeButton.dataset.reviewMode);
      return;
    }
    if (event.target.closest('#app-context-menu')) {
      this.handleContextMenuAction(event);
      return;
    } else if (this.state.contextMenu && !event.target.closest('#app-context-menu')) {
      this.closeContextMenu();
    }
    if (this.handleReviewAction(action, event)) return;
    if (this.handleReviewToolbarAction(action, event)) return;
    if (this.handleDictionaryAction(action, event)) return;
    if (this.handleMobileAction(action, event)) return;
    if (action === 'dump-full-kb') {
      this.openDumpChooser('full-kb');
      return;
    }
    if (action === 'dump-kb-characters') {
      this.openDumpChooser('kb-characters');
      return;
    }
    if (action === 'dump-kb-locations') {
      this.openDumpChooser('kb-locations');
      return;
    }
    if (action === 'dump-kb-timeline') {
      this.openDumpChooser('kb-timeline');
      return;
    }
    if (action === 'dump-kb-notes') {
      this.openDumpChooser('kb-notes');
      return;
    }
    if (action === 'dump-single-entity') {
      const button = event.target.closest('[data-lore-id]');
      const id = button?.dataset.loreId;
      const type = button?.dataset.loreType;
      if (id && type) {
        let item;
        if (type === 'subtimeline') {
          const parentId = button?.dataset.parentId;
          const parent = this.timelineEvent(parentId);
          item = parent?.subEvents?.find(sub => sub.id === id);
        } else {
          item = this.state.lore[type]?.find(e => e.id === id);
        }
        if (item) {
          const name = item.displayName || item.name || item.title || 'entity';
          const cleanName = name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_ -]/g, '');
          this.openDumpChooser('single-entity', { type, item, cleanName });
        }
      }
      return;
    }
    if (action === 'open-lore-detail') {
      const button = event.target.closest('[data-entity-kind][data-entity-id]');
      if (button) this.openLoreDetail(button.dataset.entityKind, button.dataset.entityId);
      return;
    }
    if (action === 'back-lore-list') {
      const paneId = event.target.closest('[data-pane-id]')?.dataset.paneId || event.target.closest('.workspace-pane[data-pane-id]')?.dataset.paneId;
      if (paneId) {
        const pane = this.getPane(paneId);
        if (pane && (pane.type === 'character-detail' || pane.type === 'location-detail' || pane.type === 'note-detail')) {
          const originalType = pane.type;
          pane.type = 'kb-tab';
          pane.kbTab = originalType === 'location-detail' ? 'locations' : originalType === 'note-detail' ? 'notes' : 'characters';
          pane.entityId = null;
          pane.entityType = null;
          this.persistWorkspaceState();
          this.renderWorkspacePane(paneId);
          return;
        }
      }
      this.state.activeLoreDetail = null;
      if (this.isMobileLayout()) {
        this.renderMobileShell();
      } else {
        this.renderKb();
      }
      return;
    }
    if (action === 'open-lore-side') {
      const button = event.target.closest('[data-entity-kind][data-entity-id]');
      if (button) this.openSecondaryPane({ type: `${button.dataset.entityKind}-detail`, entityType: button.dataset.entityKind, entityId: button.dataset.entityId });
      return;
    }
    if (action === 'open-doc-right') {
      const target = event.target.closest('[data-ctx-doc], .doc-item[data-doc-id]');
      const docId = target?.dataset.ctxDoc || target?.dataset.docId;
      if (docId) this.openSecondaryPane({ type: 'document', docId });
      this.closeDocContextMenu();
      return;
    }
    if (action === 'open-kb-right') {
      const tab = event.target.closest('[data-kb-tab]')?.dataset.kbTab || 'characters';
      this.openSecondaryPane({ type: 'kb-tab', kbTab: tab });
      this.closeFloatingMenu('kb');
      return;
    }
    if (action === 'close-secondary-pane') {
      this.closeSecondaryPane();
      this.hideSplitMenu();
      return;
    }
    if (action === 'toggle-split-menu') {
      this.toggleSplitMenu();
      return;
    }
    if (action === 'split-empty-right') {
      this.openSplitWithEmptyPane('right');
      this.hideSplitMenu();
      return;
    }
    if (action === 'split-empty-left') {
      this.openSplitWithEmptyPane('left');
      this.hideSplitMenu();
      return;
    }
    if (action === 'toggle-nocturned-export') {
      this.state.exportNocturned = !this.state.exportNocturned;
      safeSetStorageItem(localStorage, 'nocturne-export-nocturned', String(this.state.exportNocturned));
      this.renderSettings();
      return;
    }
        if (action === 'delete-custom-font') {
      const button = event.target.closest('[data-font-idx]');
      const idx = parseInt(button?.dataset.fontIdx, 10);
      if (Number.isFinite(idx) && this.state.settings.customFonts) {
        const font = this.state.settings.customFonts[idx];
        this.state.settings.customFonts.splice(idx, 1);
        if (this.state.settings.fontFamily === font.name) {
          this.state.settings.fontFamily = 'Lora';
        }
        this.persistSettings();
        this.injectCustomFonts();
        this.renderSettings();
        this.toast('Шрифт удален.');
      }
      return;
    }
    if (action === 'new-floating-note') {
      this.createFloatingNote();
      if (this.isMobileLayout()) this.closeMobileToEditor();
      return;
    }
    if (action === 'toggle-floating-note-menu') {
      this.toggleFloatingNoteMenu();
      return;
    }
    if (action === 'create-document-floating-note') {
      const doc = this.getFocusedDoc();
      if (doc) this.createFloatingNote({ scope: 'document', linkedId: doc.id });
      this.hideFloatingNoteMenu();
      return;
    }
    if (action === 'create-global-floating-note') {
      this.createFloatingNote({ scope: 'global', linkedId: null });
      this.hideFloatingNoteMenu();
      return;
    }
    if (action === 'create-temporary-floating-note') {
      this.createFloatingNote({ scope: 'global', linkedId: null, temporary: true, title: 'Временная заметка' });
      this.hideFloatingNoteMenu();
      return;
    }
    if (action === 'open-floating-notes-manager') {
      this.state.floatingNotesManagerOpen = true;
      this.renderFloatingNotesModal();
      this.hideFloatingNoteMenu();
      return;
    }
    if (action === 'close-floating-notes-manager' || event.target.classList.contains('floating-notes-modal')) {
      this.state.floatingNotesManagerOpen = false;
      this.renderFloatingNotesModal();
      return;
    }
    if (action === 'close-shortcuts' || event.target.id === 'shortcuts-overlay') {
      this.closeShortcutsModal();
      return;
    }
    if (action === 'delete-floating-note') {
      const id = event.target.closest('[data-note-id]')?.dataset.noteId;
      if (id) this.deleteFloatingNote(id);
      return;
    }
    if (action === 'close-floating-note') {
      const id = event.target.closest('[data-note-id]')?.dataset.noteId;
      if (id) this.closeFloatingNote(id);
      return;
    }
    if (action === 'toggle-floating-note-minimized') {
      const id = event.target.closest('[data-note-id]')?.dataset.noteId;
      if (id) this.toggleFloatingNoteMinimized(id);
      return;
    }
    if (action === 'toggle-floating-note-pin') {
      const id = event.target.closest('[data-note-id]')?.dataset.noteId;
      if (id) this.toggleFloatingNotePinned(id);
      return;
    }
    if (action === 'rename-floating-note') {
      const title = event.target.closest('.floating-note')?.querySelector('[data-floating-title]');
      if (title) this.beginFloatingNoteRename(title);
      return;
    }
    if (action === 'toggle-floating-notes-show-all') {
      this.state.floatingNotesShowAll = !this.state.floatingNotesShowAll;
      this.renderFloatingNotes();
      this.renderFloatingNotesManager();
      return;
    }
    if (action === 'focus-floating-note') {
      const id = event.target.closest('[data-note-id]')?.dataset.noteId;
      if (id) {
        const note = this.state.floatingNotes.find((item) => item.id === id);
        const wasVisible = note ? this.floatingNoteVisible(note) : false;
        if (note) {
          note.hidden = false;
          note.forceVisible = true;
          note.minimized = false;
          note.updatedAt = Date.now();
          this.saveFloatingNoteNow(id);
        }
        this.bringFloatingNoteToFront(id, { render: !wasVisible });
        if (event.target.closest('.floating-notes-modal-panel')) {
          this.state.floatingNotesManagerOpen = false;
          this.renderFloatingNotesModal();
        }
      }
      return;
    }
    if (action === 'new-lore-floating-note') {
      const button = event.target.closest('[data-entity-kind][data-entity-id]');
      if (button) this.createFloatingNote({ scope: button.dataset.entityKind, linkedId: button.dataset.entityId, title: 'Заметка к досье', forceVisible: true });
      return;
    }
    if (action === 'open-subtimeline') {
      const button = event.target.closest('[data-lore-id]');
      const paneEl = event.target.closest('.workspace-pane[data-pane-id]');
      const paneId = paneEl?.dataset.paneId;
      if (button && paneId && this.openPaneSubtimeline(paneId, button.dataset.loreId)) return;
      if (button) this.openSubtimeline(button.dataset.loreId);
      return;
    }
    if (action === 'close-pane-subtimeline') {
      const paneId = event.target.closest('[data-pane-id]')?.dataset.paneId || event.target.closest('.workspace-pane[data-pane-id]')?.dataset.paneId;
      if (paneId) this.closePaneSubtimeline(paneId);
      return;
    }
    if (action === 'close-subtimeline' || event.target.classList.contains('subtimeline-overlay')) {
      this.closeSubtimeline();
      return;
    }
    if (action === 'new-subtimeline-event') {
      const parentId = event.target.closest('[data-parent-id]')?.dataset.parentId || this.state.activeSubtimelineId;
      if (parentId) this.editLore('subtimeline', null, parentId);
      return;
    }
    if (action === 'edit-lore') {
      const button = event.target.closest('[data-lore-type][data-lore-id]');
      if (button) {
        this.hideEntityHoverCards();
        this.editLore(button.dataset.loreType, button.dataset.loreId, button.dataset.parentId);
      }
      return;
    }
    if (action === 'delete-lore') {
      const button = event.target.closest('[data-lore-type][data-lore-id]');
      if (button) this.confirmDeleteLore(button.dataset.loreType, button.dataset.loreId, button.dataset.parentId);
      return;
    }
    if (action === 'new-folder') {
      this.openFolderForm();
      return;
    }
    if (action === 'rename-folder') {
      const folderId = event.target.closest('[data-folder-id]')?.dataset.folderId;
      if (folderId) this.openFolderForm(folderId);
      return;
    }
    if (action === 'delete-folder') {
      const folderId = event.target.closest('[data-folder-id]')?.dataset.folderId;
      if (folderId) this.confirmDeleteFolder(folderId);
      return;
    }
    if (action === 'toggle-folder') {
      const folderId = event.target.closest('[data-folder]')?.dataset.folder;
      if (folderId) this.toggleFolder(folderId);
      return;
    }
    if (action === 'pin-doc') {
      const docId = event.target.closest('[data-ctx-doc]')?.dataset.ctxDoc;
      if (docId) this.pinDoc(docId);
      this.closeDocContextMenu();
      return;
    }
    if (action === 'edit-doc') {
      const docId = event.target.closest('[data-ctx-doc]')?.dataset.ctxDoc;
      if (docId) this.editDocForm(docId);
      this.closeDocContextMenu();
      return;
    }
    if (action === 'delete-doc') {
      const docId = event.target.closest('[data-ctx-doc]')?.dataset.ctxDoc || event.target.closest('[data-doc-id]')?.dataset.docId || this.state.activeDocId;
      if (docId) this.confirmDeleteDoc(docId);
      this.closeDocContextMenu();
      return;
    }
    if (action === 'duplicate-doc') {
      const docId = event.target.closest('[data-ctx-doc]')?.dataset.ctxDoc || event.target.closest('[data-doc-id]')?.dataset.docId;
      if (docId) this.duplicateDoc(docId);
      this.closeDocContextMenu();
      return;
    }
    if (action) this.runAction(action, event);
    if (action === 'new-doc') return;
    const settingToggle = event.target.closest('[data-setting][data-kind="toggle"]');
    if (settingToggle) this.updateSettingFromControl(settingToggle);
    const docMenuBtn = event.target.closest('[data-doc-menu]');
    if (docMenuBtn) {
      event.stopPropagation();
      this.toggleDocContextMenu(docMenuBtn.dataset.docMenu, docMenuBtn);
      return;
    }
    const docItem = event.target.closest('.doc-item[data-doc-id]');
    if (docItem && Date.now() >= this.kbSuppressClickUntil && !event.target.closest('.doc-context-menu') && !event.target.closest('.doc-menu-btn')) {
      this.selectDoc(docItem.dataset.docId);
      if (docItem.closest('#mobile-panel, #mobile-tab-surface')) this.closeMobileToEditor();
    }
    const kbOpen = event.target.closest('[data-kb-open]')?.dataset.kbOpen;
    if (kbOpen) this.openKb(kbOpen);
    const kbTab = event.target.closest('[data-kb-tab]')?.dataset.kbTab;
    if (kbTab) {
      this.state.activeKbTab = kbTab;
      this.state.activeLoreDetail = null;
      if (kbTab !== 'timeline') this.state.activeSubtimelineId = null;
      this.renderKb();
    }
    const settingsTab = event.target.closest('[data-settings-tab]')?.dataset.settingsTab;
    if (settingsTab) {
      this.state.activeSettingsTab = settingsTab;
      if (this.isMobileLayout()) {
        this.state.mobile.settingsTab = settingsTab;
        this.renderMobileShell();
      } else {
        this.renderSettings();
      }
    }
    const mobileSettingsTab = event.target.closest('[data-mobile-settings-tab]')?.dataset.mobileSettingsTab;
    if (mobileSettingsTab) {
      this.state.mobile.settingsTab = mobileSettingsTab;
      this.renderMobileShell();
      return;
    }
    const mobileKbTab = event.target.closest('[data-mobile-kb-tab]')?.dataset.mobileKbTab;
    if (mobileKbTab) {
      if (mobileKbTab === (this.state.mobile.kbTab || this.state.activeKbTab || 'characters') && !this.state.activeLoreDetail && !this.state.activeSubtimelineId) {
        return;
      }
      this.state.mobile.kbTab = mobileKbTab;
      this.state.activeKbTab = mobileKbTab;
      if (mobileKbTab !== 'timeline') this.state.activeSubtimelineId = null;
      if (!this.renderMobileKbContentOnly()) this.renderMobileShell();
      return;
    }
    const mobileNotesMode = event.target.closest('[data-mobile-notes-mode]')?.dataset.mobileNotesMode;
    if (mobileNotesMode) {
      this.state.mobile.notesMode = mobileNotesMode;
      this.state.noteMode = mobileNotesMode;
      this.renderMobileShell();
      return;
    }
    const dictionaryFilter = event.target.closest('[data-dictionary-filter]')?.dataset.dictionaryFilter;
    if (dictionaryFilter) {
      this.updateDictionaryFilter(dictionaryFilter);
      return;
    }
    const command = event.target.closest('[data-command]')?.dataset.command;
    if (command) {
      event.preventDefault();
      this.runEditorCommand(command);
      return;
    }
    const formatBlock = event.target.closest('[data-format-block]')?.dataset.formatBlock;
    if (formatBlock) {
      event.preventDefault();
      this.setCurrentBlockType(formatBlock);
      return;
    }
    const ai = event.target.closest('[data-ai]')?.dataset.ai;
    if (ai) this.runAi(ai);
    const loreCard = event.target.closest('[data-lore-id]');
    if (loreCard && Date.now() >= this.kbSuppressClickUntil) {
      if (['characters', 'locations'].includes(loreCard.dataset.loreType)) this.openLoreDetail(loreCard.dataset.loreType, loreCard.dataset.loreId);
      else this.editLore(loreCard.dataset.loreType, loreCard.dataset.loreId, loreCard.dataset.parentId);
    }
    if (!insideFloatingMenu) {
      this.closeAllFloatingMenus();
    }
  }

  handleMobileAction(action, event) {
    if (!action) return false;
    const open = (panel, tab = null, options = {}) => {
      this.openMobilePanel(panel, tab, options);
      return true;
    };
    const map = {
      'mobile-tab-write': () => this.switchMobileTab('write'),
      'mobile-open-docs': () => this.switchMobileTab('docs'),
      'mobile-open-actions': () => open('actions', 'write'),
      'mobile-open-more': () => this.switchMobileTab('more'),
      'mobile-open-settings': () => open('settings', 'more'),
      'mobile-open-ai-settings': () => { this.state.mobile.settingsTab = 'ai'; this.openMobilePanel('settings', 'more'); },
      'mobile-open-lore': () => this.switchMobileTab('lore'),
      'mobile-open-ai': () => this.switchMobileTab('ai'),
      'mobile-open-notes': () => open('notes', 'more'),
      'mobile-open-export': () => open('export', 'more'),
      'mobile-close-panel': () => this.closeMobilePanel(),
      'mobile-close-all': () => this.closeMobileToEditor(),
      'mobile-back': () => this.mobileBack(),
      'mobile-settings-back': () => { this.state.mobile.settingsTab = null; this.renderMobileShell(); },
      'mobile-lore-back': () => { this.state.activeLoreDetail = null; this.renderMobileShell(); },
      'mobile-subtimeline-back': () => { this.state.activeSubtimelineId = null; this.renderMobileShell(); },
      'mobile-save-now': () => this.saveActiveDoc({ silent: false }),
      'mobile-save-notes': () => this.saveMobileNote(),
      'mobile-toggle-reorder': () => { this.state.mobile.reorderMode = !this.state.mobile.reorderMode; this.renderMobileShell(); },
      'mobile-reorder-lore': () => this.mobileReorderLore(event.target.closest('[data-lore-type][data-lore-id]')),
      'open-kb-desktop-modal': () => this.toast('Полный desktop-вид базы доступен на широком экране.'),
      'mobile-about': () => this.openAboutModal(),
      'mobile-background-app': () => {
        document.getElementById('form-overlay')?.classList.remove('active');
        window.Capacitor?.Plugins?.App?.minimizeApp?.();
      },
      'mobile-command': () => {
        const command = event.target.closest('[data-mobile-command]')?.dataset.mobileCommand;
        if (command) this.runEditorCommand(command);
      },
    };
    if (!map[action]) return false;
    map[action]();
    return true;
  }

  saveMobileNote() {
    const input = document.querySelector('[data-mobile-notes-input]');
    if (!input) return;
    const result = String(input.value || '');
    if ((this.state.mobile.notesMode || this.state.noteMode) === 'global') {
      this.state.globalNotes = result;
      if (this.state.settings.e2e) safeRemoveStorageItem(localStorage, 'nocturne-global-notes');
      else safeSetStorageItem(localStorage, 'nocturne-global-notes', result);
    } else {
      const doc = this.getFocusedDoc();
      if (!doc) {
        this.toast('Откройте документ для заметок.');
        return;
      }
      doc.notes = result;
      doc.updatedAt = Date.now();
      this.writeLiveDraft(doc.id);
      this.saveDocByIdDebounced(doc.id);
    }
    this.renderNotes();
    this.toast('Заметки сохранены.');
  }

  toggleDocContextMenu(docId, anchor) {
    const portal = document.getElementById('doc-menu-portal');
    const doc = this.state.docs.find((item) => item.id === docId);
    if (!portal || !doc || !anchor) return;
    if (portal.classList.contains('open') && portal.dataset.docId === docId) {
      this.closeDocContextMenu();
      return;
    }
    this.closeAllFloatingMenus('doc');
    this.activeFloatingMenuKey = 'doc';
    portal.dataset.docId = docId;
    portal.setAttribute('aria-hidden', 'false');
    portal.style.pointerEvents = '';
    portal.innerHTML = `
      <div class="doc-context-menu popover-surface" data-ctx-doc="${escapeHtml(doc.id)}">
        <button class="ctx-btn" data-action="open-doc-right" data-ctx-doc="${escapeHtml(doc.id)}"><i class="bx bx-sidebar"></i><span>Открыть справа</span></button>
        <button class="ctx-btn" data-action="duplicate-doc" data-ctx-doc="${escapeHtml(doc.id)}"><i class="bx bx-copy"></i><span>Дублировать</span></button>
        <button class="ctx-btn" data-action="pin-doc" data-ctx-doc="${escapeHtml(doc.id)}"><i class="bx ${doc.pinned ? 'bx-pin' : 'bxs-pin'}"></i><span>${doc.pinned ? 'Открепить' : 'Закрепить'}</span></button>
        <button class="ctx-btn" data-action="edit-doc" data-ctx-doc="${escapeHtml(doc.id)}"><i class="bx bx-edit"></i><span>Редактировать</span></button>
        <button class="ctx-btn danger" data-action="delete-doc" data-ctx-doc="${escapeHtml(doc.id)}"><i class="bx bx-trash"></i><span>Удалить</span></button>
      </div>`;
    portal.classList.add('open');
    requestAnimationFrame(() => {
      this.positionDocContextMenu(anchor);
      requestAnimationFrame(() => portal.querySelector('.doc-context-menu')?.classList.add('open'));
    });
  }

  positionDocContextMenu(anchor) {
    const portal = document.getElementById('doc-menu-portal');
    const menu = portal?.querySelector('.doc-context-menu');
    if (!portal || !menu || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 10;
    let left = anchorRect.right - menuRect.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));
    const below = anchorRect.bottom + 8;
    const above = anchorRect.top - menuRect.height - 8;
    let top = below + menuRect.height <= window.innerHeight - margin ? below : above;
    top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));
    portal.style.left = `${Math.round(left)}px`;
    portal.style.top = `${Math.round(top)}px`;
  }

  closeDocContextMenu() {
    const portal = document.getElementById('doc-menu-portal');
    if (!portal) return;
    if (this.activeFloatingMenuKey === 'doc') this.activeFloatingMenuKey = '';
    const menu = portal.querySelector('.doc-context-menu');
    if (menu) {
      menu.classList.remove('open');
      portal.style.pointerEvents = 'none';
      window.setTimeout(() => {
        portal.classList.remove('open');
        portal.setAttribute('aria-hidden', 'true');
        portal.innerHTML = '';
        portal.style.pointerEvents = '';
        delete portal.dataset.docId;
      }, 150);
      return;
    }
    portal.classList.remove('open');
    portal.setAttribute('aria-hidden', 'true');
    portal.innerHTML = '';
    delete portal.dataset.docId;
  }

  isMobileEditorCustomSelectionEnabled() {
    return this.isMobileLayout() && this.isAndroidRuntime();
  }

  rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }

  wordRangeFromPoint(x, y, editable) {
    const point = this.rangeFromPoint(x, y);
    if (!point || !editable?.contains(point.startContainer)) {
      const fallback = this.textPositionFromPoint(x, y, editable);
      return fallback ? this.wordRangeFromTextNode(fallback.node, fallback.offset) : null;
    }
    let node = point.startContainer;
    let offset = point.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      const fallback = this.textPositionFromPoint(x, y, editable);
      if (fallback) {
        node = fallback.node;
        offset = fallback.offset;
      } else {
        node = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim()) || node.firstChild;
        offset = 0;
      }
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;
    return this.wordRangeFromTextNode(node, offset);
  }

  textPositionFromPoint(x, y, editable) {
    const element = document.elementFromPoint?.(x, y);
    const block = element?.closest?.('[data-block-id], p, h2, blockquote') || editable;
    if (!block || !editable.contains(block)) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let best = null;
    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent || '';
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange();
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) continue;
        const cy = rect.top + rect.height / 2;
        const cx = Math.min(Math.max(x, rect.left), rect.right || rect.left);
        const score = Math.abs(cy - y) + Math.abs(cx - x);
        if (!best || score < best.score) {
          best = { node: textNode, offset: x > rect.left + rect.width / 2 ? i + 1 : i, score };
        }
      }
    }
    return best ? { node: best.node, offset: best.offset } : null;
  }

  wordRangeFromTextNode(node, offset) {
    const text = node.textContent;
    const clampOffset = Math.max(0, Math.min(offset, text.length));
    const isWord = (char) => /[\p{L}\p{N}_-]/u.test(char || '');
    let start = clampOffset;
    let end = clampOffset;
    if (start > 0 && !isWord(text[start]) && isWord(text[start - 1])) start -= 1;
    while (start > 0 && isWord(text[start - 1])) start -= 1;
    while (end < text.length && isWord(text[end])) end += 1;
    if (start === end) {
      start = Math.max(0, clampOffset - 1);
      end = Math.min(text.length, clampOffset + 1);
    }
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range.collapsed ? null : range;
  }

  setMobileEditorSelection(range, editable, mode = 'custom') {
    if (!range || !editable) return false;
    const paneId = editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary';
    this.selectionController = {
      active: true,
      mode,
      range: range.cloneRange(),
      docId: editable.dataset.docId || null,
      paneId,
      text: range.toString(),
      editable,
    };
    this.selectionSnapshot = {
      range: range.cloneRange(),
      caret: null,
      paneId,
      docId: editable.dataset.docId || null,
      text: range.toString(),
      custom: true,
    };
    this.state.editorSelection = {
      active: true,
      text: range.toString(),
      docId: editable.dataset.docId || null,
      paneId,
    };
    this.state.mobile.formatBarMode = 'selection';
    this.state.mobile.formatBarVisible = true;
    this.state.mobile.editorFocused = false;
    window.getSelection()?.removeAllRanges();
    // Blur is removed to prevent keyboard from closing on mobile when making custom selection
    this.updateRuntimeClasses();
    this.renderNocturneSelectionLayer();
    return true;
  }

  clearMobileEditorSelection({ keepNative = true } = {}) {
    this.mobileSelectionTimer && clearTimeout(this.mobileSelectionTimer);
    this.mobileSelectionTimer = null;
    this.mobileSelectionDrag = null;
    if (!keepNative) window.getSelection()?.removeAllRanges();
    this.selectionController = { active: false, mode: 'native', range: null, docId: null, paneId: null, text: '', editable: null };
    this.state.editorSelection = { active: false, text: '', docId: null, paneId: null };
    if (this.isMobileLayout()) {
      this.state.mobile.formatBarMode = 'hidden';
      this.state.mobile.formatBarVisible = false;
    }
    this.renderNocturneSelectionLayer();
    this.updateRuntimeClasses();
  }

  handleMobileEditorSelectionPointerDown(event) {
    if (!this.isMobileEditorCustomSelectionEnabled()) return;
    const handle = event.target.closest?.('[data-selection-handle]');
    if (handle && this.selectionController?.active) {
      event.preventDefault();
      event.stopPropagation();
      this.mobileSelectionDrag = { handle: handle.dataset.selectionHandle, pointerId: event.pointerId };
      return;
    }
    if (event.target.closest?.('.mobile-format-bar, input, textarea, button, select, .mobile-bottom-nav, .mobile-overlay')) return;
    const editable = event.target.closest?.('.page-content');
    if (!editable) return;
    this.mobileSelectionTimer && clearTimeout(this.mobileSelectionTimer);
    const start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    this.mobileSelectionStart = start;
    this.mobileSelectionTimer = window.setTimeout(() => {
      const range = this.wordRangeFromPoint(start.x, start.y, editable);
      if (range) this.setMobileEditorSelection(range, editable);
    }, 360);
  }

  handleMobileEditorSelectionPointerMove(event) {
    if (this.mobileSelectionDrag && this.selectionController?.active) {
      event.preventDefault();
      event.stopPropagation();
      const editable = this.selectionController.editable;
      const point = this.rangeFromPoint(event.clientX, event.clientY);
      const current = this.selectionController.range;
      if (!point || !current || !editable?.contains(point.startContainer)) return;
      const next = document.createRange();
      if (this.mobileSelectionDrag.handle === 'start') {
        next.setStart(point.startContainer, point.startOffset);
        next.setEnd(current.endContainer, current.endOffset);
        if (next.collapsed || next.toString() === '') {
          next.setStart(current.endContainer, current.endOffset);
          next.setEnd(point.startContainer, point.startOffset);
        }
      } else {
        next.setStart(current.startContainer, current.startOffset);
        next.setEnd(point.startContainer, point.startOffset);
        if (next.collapsed || next.toString() === '') {
          next.setStart(point.startContainer, point.startOffset);
          next.setEnd(current.startContainer, current.startOffset);
        }
      }
      if (!next.collapsed) this.setMobileEditorSelection(next, editable);
      return;
    }
    if (!this.mobileSelectionTimer) return;
    const start = this.mobileSelectionStart;
    const moved = start
      ? Math.hypot((event.clientX || 0) - start.x, (event.clientY || 0) - start.y)
      : Math.hypot(event.movementX || 0, event.movementY || 0);
    if (moved > 8) {
      clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }
  }

  handleMobileEditorSelectionPointerUp() {
    if (this.mobileSelectionTimer) {
      clearTimeout(this.mobileSelectionTimer);
      this.mobileSelectionTimer = null;
    }
    this.mobileSelectionDrag = null;
    this.mobileSelectionStart = null;
  }

  handleGlobalPointerDownCapture(event) {
    if (event.target.closest?.('.mobile-format-bar')) {
      event.preventDefault();
      event.stopPropagation();
      this.captureSelectionSnapshot();
      this.state.mobile.formatBarVisible = true;
      this.updateRuntimeClasses();
      return;
    }
    if (event.target.closest?.('.toolbar, .review-toolbar-slot, #format-dropdown, #suggestion-bar, .ai-card')) this.captureSelectionSnapshot();
    if (event.target.closest?.('.review-toolbar-slot, #review-issue-menu')) this.reviewToolbarSelectionSnapshot = this.captureSelectionSnapshot();
    if (this.state.contextMenu && !event.target.closest?.('#app-context-menu')) this.closeContextMenu();
    if (!event.target.closest?.('.doc-context-menu, .doc-menu-btn')) this.closeDocContextMenu();
    const docItem = event.target.closest?.('.doc-item[data-doc-id]');
    this.docClickCandidate = docItem && !event.target.closest?.('.doc-context-menu, .doc-menu-btn, button')
      ? { id: docItem.dataset.docId, x: event.clientX, y: event.clientY, time: Date.now() }
      : null;
  }

  handleFormatBarPress(event) {
    if (!event.target.closest?.('.mobile-format-bar')) return;
    event.preventDefault();
    event.stopPropagation();
    this.captureSelectionSnapshot();
    this.mobileFormatAction = {
      command: event.target.closest('[data-command]')?.dataset.command || '',
      block: event.target.closest('[data-format-block]')?.dataset.formatBlock || '',
      action: event.target.closest('[data-action]')?.dataset.action || '',
    };
    this.state.mobile.formatBarVisible = true;
    this.updateRuntimeClasses();
  }

  handleFormatBarPointerUp(event) {
    const bar = event.target.closest?.('.mobile-format-bar');
    if (!bar) return;
    const command = event.target.closest('[data-command]')?.dataset.command || this.mobileFormatAction?.command;
    const formatBlock = event.target.closest('[data-format-block]')?.dataset.formatBlock || this.mobileFormatAction?.block;
    const action = event.target.closest('[data-action]')?.dataset.action || this.mobileFormatAction?.action;
    event.preventDefault();
    event.stopPropagation();
    this.mobileFormatAction = null;
    if (command) {
      this.runEditorCommand(command);
      return;
    }
    if (formatBlock) {
      this.setCurrentBlockType(formatBlock);
      return;
    }
    if (action) this.handleMobileAction(action, event) || this.handleAction(action, event);
  }

  handleDocPointerUpCapture(event) {
    const candidate = this.docClickCandidate;
    this.docClickCandidate = null;
    if (!candidate || Date.now() < this.kbSuppressClickUntil) return;
    if (event.target.closest?.('.doc-context-menu, .doc-menu-btn, button')) return;
    const dx = Math.abs(event.clientX - candidate.x);
    const dy = Math.abs(event.clientY - candidate.y);
    if (dx > 5 || dy > 5) return;
    const docItem = event.target.closest?.('.doc-item[data-doc-id]');
    if (!docItem || docItem.dataset.docId !== candidate.id || candidate.id === this.state.activeDocId) return;
    event.preventDefault();
    event.stopPropagation();
    this.selectDoc(candidate.id);
  }

  runEditorCommand(command) {
    if (this.state.reviewMode === 'editor') return;
    const paneId = this.selectionSnapshot?.paneId || this.state.workspace?.focusedPaneId || 'primary';
    if (this.nocturneEditor?.runCommand(paneId, command)) {
      this.nocturneEditor.scheduleVisualPages(paneId);
      this.updateToolbarState();
      return;
    }
    const inlineCommand = ['bold', 'italic', 'underline', 'strikeThrough'].includes(command);
    if (!this.selectionController?.active && inlineCommand && this.selectionSnapshot?.text && this.selectionSnapshot.docId) {
      const snapshotEditable = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(this.selectionSnapshot.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(this.selectionSnapshot.docId)}"]`);
      const freshRange = snapshotEditable ? this.rangeForTextInEditable(snapshotEditable, this.selectionSnapshot.text) : null;
      if (freshRange && !freshRange.collapsed) this.selectionSnapshot.range = freshRange.cloneRange();
      if (snapshotEditable && this.applySnapshotInlineFormat(command, snapshotEditable)) {
        this.editorInput(snapshotEditable);
        this.updateToolbarState();
        return;
      }
    }
    if (!this.selectionController?.active && !(inlineCommand && this.selectionSnapshot?.text)) {
      this.restoreSelectionSnapshot(this.selectionSnapshot);
    }
    const snapshotEditable = (!this.selectionController?.active && inlineCommand && this.selectionSnapshot?.text && this.selectionSnapshot.docId)
      ? document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(this.selectionSnapshot.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(this.selectionSnapshot.docId)}"]`)
      : null;
    const editable = this.selectionController?.active
      ? this.selectionController.editable
      : (snapshotEditable || this.editableFromSelection() || this.getFocusedEditable());
    if (!editable) {
      this.toast('Не удалось определить место редактирования. Выделите текст снова.');
      return;
    }
    if (!this.selectionController?.active) {
      const sel = getSelection();
      if (!sel?.rangeCount) editable?.focus();
    }
    const alignMap = { justifyLeft: 'left', justifyCenter: 'center', justifyFull: 'justify' };
    if (alignMap[command]) {
      this.setCurrentBlockAlign(alignMap[command]);
      return;
    }
    if (command === 'undo' || command === 'redo') {
      this.toast(command === 'undo' ? 'Используйте Ctrl+Z для отмены.' : 'Используйте Ctrl+Y или Ctrl+Shift+Z для повтора.');
      return;
    }
    if (!this.toggleInlineFormat(command)) return;
    this.editorInput(editable);
    this.updateToolbarState();
  }

  toggleInlineFormat(command) {
    const tagName = { bold: 'strong', italic: 'em', underline: 'u', strikeThrough: 's' }[command];
    const customSelection = !!this.selectionController?.active;
    const isRangeValid = (r, container) => {
      return r && container && container.contains(r.startContainer) && container.contains(r.endContainer);
    };

    if (!customSelection && tagName && this.selectionSnapshot?.text && this.selectionSnapshot.docId) {
      const editable = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(this.selectionSnapshot.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(this.selectionSnapshot.docId)}"]`);
      const range = editable
        ? (isRangeValid(this.selectionSnapshot.range, editable)
            ? this.selectionSnapshot.range.cloneRange()
            : this.rangeForTextInEditable(editable, this.selectionSnapshot.text))
        : null;
      if (editable && range && !range.collapsed) {
        const touchedBlocks = new Set(this.textNodesInRange(range)
          .map((node) => node.parentElement?.closest?.('[data-block-id]'))
          .filter(Boolean));
        if (touchedBlocks.size > 1) {
          this.toast('Форматирование выделения через несколько абзацев пока не поддерживается.');
          return false;
        }
        try {
          const directMark = this.inlineMarkFor(range.startContainer, tagName);
          const nextRange = directMark && editable.contains(directMark)
            ? this.unwrapSpecificInlineMark(directMark, editable, this.selectionSnapshot.text)
            : this.wrapInlineRange(range, tagName);
          if (!nextRange) return false;
          const stableRange = isRangeValid(range, editable) ? nextRange : (this.rangeForTextInEditable(editable, this.selectionSnapshot.text) || nextRange);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(stableRange);
          this.selectionSnapshot = {
            range: stableRange.cloneRange(),
            caret: null,
            paneId: editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary',
            docId: editable.dataset.docId || null,
            text: stableRange.toString() || this.selectionSnapshot.text,
          };
          this.updateEditorSelectionState();
          this.renderNocturneSelectionLayer();
          return true;
        } catch {
          return false;
        }
      }
    }
    const sel = getSelection();
    let range = customSelection ? this.selectionController.range?.cloneRange() : (sel?.rangeCount ? sel.getRangeAt(0) : null);
    if (!customSelection && (!range || range.collapsed) && this.selectionSnapshot?.range && this.selectionSnapshot.text) {
      range = this.selectionSnapshot.range.cloneRange();
    }
    if (!tagName || !range) {
      this.toast('Выделите текст для форматирования.');
      return false;
    }
    let editable = customSelection ? this.selectionController.editable : this.editableFromSelection();
    if (!customSelection && this.selectionSnapshot?.text && this.selectionSnapshot.docId) {
      const snapshotEditable = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(this.selectionSnapshot.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(this.selectionSnapshot.docId)}"]`);
      if (snapshotEditable) {
        editable = snapshotEditable;
        range = isRangeValid(this.selectionSnapshot.range, editable)
          ? this.selectionSnapshot.range.cloneRange()
          : (this.rangeForTextInEditable(editable, this.selectionSnapshot.text) || range);
      }
    }
    if (!customSelection && this.selectionSnapshot?.range && (!editable || !editable.contains(range.commonAncestorContainer))) {
      const snapshot = this.selectionSnapshot;
      editable = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(snapshot.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(snapshot.docId || '')}"]`)
        || (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest?.('.page-content');
    }
    const selectionText = customSelection
      ? (this.selectionController.text || range.toString())
      : (range.toString() || this.selectionSnapshot?.text || '');
    if (selectionText && !isRangeValid(range, editable)) {
      range = this.rangeForTextInEditable(editable, selectionText) || range;
    }
    if (!editable || !editable.contains(range.commonAncestorContainer)) {
      this.toast('Выделение не находится в редакторе.');
      return false;
    }

    // Expand to word if collapsed (caret clicked inside/next to a word)
    let isCollapsedWordFormat = false;
    if (!customSelection && range.collapsed) {
      const expanded = this.expandRangeToWord(range);
      if (expanded) {
        range = expanded;
        isCollapsedWordFormat = true;
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    if (range.collapsed) {
      document.execCommand(command, false, null);
      this.captureSelectionSnapshot();
      return true;
    }
    const touchedBlocks = new Set(this.textNodesInRange(range)
      .map((node) => node.parentElement?.closest?.('[data-block-id]'))
      .filter(Boolean));
    if (touchedBlocks.size > 1) {
      this.toast('Форматирование выделения через несколько абзацев пока не поддерживается.');
      return false;
    }
    try {
      const nextRange = this.selectionFullyMarked(range, tagName)
        ? this.unwrapInlineMarksInRange(range, tagName)
        : this.wrapInlineRange(range, tagName);
      if (!nextRange) return false;
      if (customSelection) {
        const stableRange = isRangeValid(range, editable) ? nextRange : (this.rangeForTextInEditable(editable, selectionText) || nextRange);
        this.setMobileEditorSelection(stableRange, editable);
      } else {
        const stableRange = isRangeValid(range, editable) ? nextRange : (this.rangeForTextInEditable(editable, selectionText) || nextRange);
        sel.removeAllRanges();
        sel.addRange(stableRange);
        const paneId = editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary';
        this.selectionSnapshot = {
          range: stableRange.cloneRange(),
          caret: null,
          paneId,
          docId: editable.dataset.docId || null,
          text: stableRange.toString(),
        };
        this.updateEditorSelectionState();
        this.renderNocturneSelectionLayer();
      }
      return true;
    } catch {
      return false;
    }
  }

  applySnapshotInlineFormat(command, editable) {
    const tagName = { bold: 'strong', italic: 'em', underline: 'u', strikeThrough: 's' }[command];
    const text = this.selectionSnapshot?.text || '';
    if (!tagName || !text || !editable) return false;
    const range = this.rangeForTextInEditable(editable, text);
    if (!range || range.collapsed) return false;
    const touchedBlocks = new Set(this.textNodesInRange(range)
      .map((node) => node.parentElement?.closest?.('[data-block-id]'))
      .filter(Boolean));
    if (touchedBlocks.size > 1) {
      this.toast('Форматирование выделения через несколько абзацев пока не поддерживается.');
      return false;
    }
    try {
      const mark = this.inlineMarkFor(range.startContainer, tagName);
      const nextRange = mark && editable.contains(mark)
        ? this.unwrapSpecificInlineMark(mark, editable, text)
        : this.wrapInlineRange(range, tagName);
      if (!nextRange) return false;
      const stableRange = this.rangeForTextInEditable(editable, text) || nextRange;
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(stableRange);
      this.selectionSnapshot = {
        range: stableRange.cloneRange(),
        caret: null,
        paneId: editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary',
        docId: editable.dataset.docId || null,
        text,
      };
      this.updateEditorSelectionState();
      this.renderNocturneSelectionLayer();
      return true;
    } catch {
      return false;
    }
  }

  rangeIntersectsNode(range, node) {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  inlineMarkFor(node, tagName) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return el?.closest?.(tagName) || null;
  }

  textNodesInRange(range) {
    const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => this.rangeIntersectsNode(range, node) && node.textContent.trim()
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  selectionFullyMarked(range, tagName) {
    const nodes = this.textNodesInRange(range);
    return nodes.length > 0 && nodes.every((node) => !!this.inlineMarkFor(node, tagName));
  }

  unwrapInlineMarksInRange(range, tagName) {
    const editable = (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest?.('.page-content');
    if (!editable) return null;
    const selectedText = range.toString();
    const marks = [...new Set(this.textNodesInRange(range).map((node) => this.inlineMarkFor(node, tagName)).filter(Boolean))];
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
    return this.rangeForTextInEditable(editable, selectedText) || this.caretRangeAtEnd(editable);
  }

  unwrapSpecificInlineMark(mark, editable, selectedText = '') {
    if (!mark || !editable?.contains(mark)) return null;
    const text = selectedText || mark.textContent || '';
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
    return this.rangeForTextInEditable(editable, text) || this.caretRangeAtEnd(editable);
  }

  wrapInlineRange(range, tagName) {
    const wrapper = document.createElement(tagName);
    const fragment = range.extractContents();
    wrapper.appendChild(fragment);
    this.mergeNestedInline(wrapper, tagName);
    range.insertNode(wrapper);
    const nextRange = document.createRange();
    nextRange.selectNodeContents(wrapper);
    wrapper.parentNode?.normalize();
    return nextRange;
  }

  mergeNestedInline(root, tagName) {
    root.querySelectorAll?.(tagName).forEach((nested) => {
      const parent = nested.parentNode;
      while (nested.firstChild) parent.insertBefore(nested.firstChild, nested);
      parent.removeChild(nested);
    });
  }

  rangeForTextInEditable(editable, text) {
    if (!text) return null;
    const full = editable.textContent || '';
    const start = full.indexOf(text);
    if (start < 0) return null;
    const end = start + text.length;
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let node;
    let offset = 0;
    let startNode = null;
    let endNode = null;
    let startOffset = 0;
    let endOffset = 0;
    let startSet = false;
    let endSet = false;
    while ((node = walker.nextNode())) {
      const next = offset + node.textContent.length;
      if (!startSet && start >= offset && (start < next || (start === end && start <= next))) {
        startNode = node;
        startOffset = start - offset;
        startSet = true;
      }
      if (!endSet && end >= offset && end <= next) {
        endNode = node;
        endOffset = end - offset;
        endSet = true;
        break;
      }
      offset = next;
    }
    if (!startSet || !endSet || !startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  caretRangeAtEnd(editable) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    return range;
  }

  currentBlockElement() {
    const sel = getSelection();
    const node = sel?.anchorNode?.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel?.anchorNode;
    const block = node?.closest?.('[data-block-id]');
    const editable = block?.closest?.('.page-content');
    if (!block || !editable) return null;
    const focusedDoc = this.getFocusedDoc();
    if (focusedDoc && editable.dataset.docId !== focusedDoc.id) return null;
    return block;
  }

  editableFromSelection() {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const node = sel.getRangeAt(0).commonAncestorContainer;
    return (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest?.('.page-content') || null;
  }

  captureSelectionSnapshot() {
    if (this.selectionController?.active && this.selectionController.range) {
      this.selectionSnapshot = {
        range: this.selectionController.range.cloneRange(),
        caret: null,
        paneId: this.selectionController.paneId,
        docId: this.selectionController.docId,
        text: this.selectionController.text,
        custom: true,
      };
      return this.selectionSnapshot;
    }
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const editable = this.editableFromSelection();
    if (!editable) return null;
    if (sel.isCollapsed || !sel.toString().trim()) {
      const activeEditable = document.activeElement?.closest?.('.page-content');
      if (!activeEditable && this.selectionSnapshot?.range && this.selectionSnapshot.text && this.selectionSnapshot.docId === (editable.dataset.docId || null)) {
        return this.selectionSnapshot;
      }
    }
    const paneId = editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary';
    const snapshot = {
      range: sel.getRangeAt(0).cloneRange(),
      caret: this.getCaretSnapshot(),
      paneId,
      docId: editable.dataset.docId || null,
      text: sel.toString(),
    };
    this.selectionSnapshot = snapshot;
    return snapshot;
  }

  restoreSelectionSnapshot(snapshot = this.selectionSnapshot) {
    if (!snapshot?.range || !snapshot.docId || !snapshot.paneId) return false;
    const editable = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(snapshot.paneId)}"] .page-content[data-doc-id="${CSS.escape(snapshot.docId)}"]`);
    if (!editable) return false;
    if (snapshot.custom || (this.isMobileEditorCustomSelectionEnabled() && this.selectionController?.active)) {
      return this.setMobileEditorSelection(snapshot.range.cloneRange(), editable);
    }
    try {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(snapshot.range.cloneRange());
      if (!editable.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        sel.removeAllRanges();
        return this.restoreCaret(snapshot.caret);
      }
      if (snapshot.range.collapsed) editable.focus();
      if (this.state.workspace?.focusedPaneId !== snapshot.paneId) this.setFocusedPane(snapshot.paneId);
      return true;
    } catch {
      return this.restoreCaret(snapshot.caret);
    }
  }

  updateEditorSelectionState() {
    if (this.selectionController?.active) {
      this.state.editorSelection = {
        active: true,
        text: this.selectionController.text || this.selectionController.range?.toString() || '',
        docId: this.selectionController.docId,
        paneId: this.selectionController.paneId,
      };
      if (this.isMobileLayout()) {
        this.state.mobile.formatBarMode = 'selection';
        this.state.mobile.formatBarVisible = true;
      }
      this.updateRuntimeClasses();
      return;
    }
    const sel = getSelection();
    const editable = this.editableFromSelection();
    const active = !!(sel?.rangeCount && editable && !sel.isCollapsed && sel.toString().trim());
    this.state.editorSelection = {
      active,
      text: active ? sel.toString() : '',
      docId: active ? editable.dataset.docId || null : null,
      paneId: active ? editable.dataset.paneId || editable.closest('.workspace-pane')?.dataset.paneId || 'primary' : null,
    };
    this.state.mobile.formatBarVisible = this.isMobileLayout() && (active || !!document.activeElement?.closest?.('.page-content'));
    this.updateRuntimeClasses();
  }

  ensureNocturneSelectionLayer() {
    if (this.nocturneSelectionLayer?.isConnected) return this.nocturneSelectionLayer;
    const layer = document.createElement('div');
    layer.id = 'nocturne-selection-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    this.nocturneSelectionLayer = layer;
    return layer;
  }

  renderNocturneSelectionLayer() {
    const layer = this.ensureNocturneSelectionLayer();
    const custom = !!(this.selectionController?.active && this.selectionController.range && this.selectionController.editable);
    const sel = getSelection();
    const editable = custom ? this.selectionController.editable : this.editableFromSelection();
    const range = custom ? this.selectionController.range.cloneRange() : (sel?.rangeCount ? sel.getRangeAt(0) : null);
    if (!range || range.collapsed || !editable) {
      layer.classList.remove('active');
      layer.innerHTML = '';
      this._lastSerializedRects = '';
      return;
    }

    const rects = [...range.getClientRects()]
      .filter((rect) => rect.width > 1 && rect.height > 1)
      .map((rect) => ({
        left: Math.round(rect.left - 2),
        top: Math.round(rect.top - 1),
        width: Math.round(rect.width + 4),
        height: Math.round(rect.height + 2),
      }));

    if (!rects.length) {
      layer.classList.remove('active');
      layer.innerHTML = '';
      this._lastSerializedRects = '';
      return;
    }

    const serialized = rects.map(r => `${r.left},${r.top},${r.width},${r.height}`).join(';');
    if (this._lastSerializedRects === serialized) {
      return;
    }
    this._lastSerializedRects = serialized;

    const merged = [];
    rects.forEach((rect) => {
      const last = merged.at(-1);
      if (last && Math.abs(last.top - rect.top) < 3 && Math.abs(last.height - rect.height) < 5 && rect.left <= last.left + last.width + 8) {
        const right = Math.max(last.left + last.width, rect.left + rect.width);
        last.left = Math.min(last.left, rect.left);
        last.width = right - last.left;
        last.height = Math.max(last.height, rect.height);
      } else {
        merged.push({ ...rect });
      }
    });

    layer.classList.add('active');
    const highlights = merged.map((rect) => `<span class="nocturne-selection-rect" style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px"></span>`).join('');
    const handles = custom && merged.length
      ? (() => {
          const first = merged[0];
          const last = merged[merged.length - 1];
          const startLeft = Math.max(8, first.left - 8);
          const startTop = Math.max(8, first.top + first.height - 2);
          const endLeft = Math.max(8, last.left + last.width - 8);
          const endTop = Math.max(8, last.top + last.height - 2);
          return `
            <span class="nocturne-selection-handle start" data-selection-handle="start" style="left:${startLeft}px;top:${startTop}px"></span>
            <span class="nocturne-selection-handle end" data-selection-handle="end" style="left:${endLeft}px;top:${endTop}px"></span>`;
        })()
      : '';
    layer.innerHTML = `${highlights}${handles}`;
  }

  setCurrentBlockAlign(align) {
    if (this.state.reviewMode === 'editor') return;
    const paneId = this.selectionSnapshot?.paneId || this.state.workspace?.focusedPaneId || 'primary';
    const command = align === 'center' ? 'justifyCenter' : align === 'justify' ? 'justifyFull' : 'justifyLeft';
    if (this.nocturneEditor?.runCommand(paneId, command)) {
      this.updateToolbarState();
      return;
    }
    const block = this.currentBlockElement();
    if (!block) return;
    block.style.textAlign = align;
    const editable = block.closest('.page-content');
    const sel = getSelection();
    if (sel?.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const startBlock = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest?.('[data-block-id]');
      const endBlock = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement)?.closest?.('[data-block-id]');
      if (startBlock && endBlock && startBlock !== endBlock) {
        this.toast('Смена стиля для выделения через несколько абзацев пока не поддерживается.');
        return;
      }
    }
    this.editorInput(editable);
    this.updateToolbarState();
    setTimeout(() => {
      const sel = getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      this.updateCustomCaret();
    }, 10);
    setTimeout(() => this.updateCustomCaret(), 100);
  }

  setCurrentBlockType(type) {
    if (this.state.reviewMode === 'editor') return;
    const paneId = this.selectionSnapshot?.paneId || this.state.workspace?.focusedPaneId || 'primary';
    if (this.nocturneEditor?.runCommand(paneId, 'formatBlock', type)) {
      this.closeFloatingMenu('format');
      this.updateFormatLabel(type);
      this.updateToolbarState();
      return;
    }
    this.restoreSelectionSnapshot(this.selectionSnapshot);
    const block = this.currentBlockElement();
    if (!block) {
      this.toast('Не удалось определить место редактирования. Выделите текст снова.');
      return;
    }
    const editable = block.closest('.page-content');
    const tag = type === 'heading' ? 'h2' : type === 'quote' ? 'blockquote' : 'p';
    if (block.tagName.toLowerCase() !== tag) {
      const next = document.createElement(tag);
      next.dataset.blockId = block.dataset.blockId;
      next.style.textAlign = block.style.textAlign || 'left';
      next.innerHTML = block.innerHTML || '<br>';
      block.replaceWith(next);
      this.placeCaretAtEnd(next);
    }
    this.closeFloatingMenu('format');
    this.updateFormatLabel(type);
    setTimeout(() => this.editorInput(editable), 0);
    setTimeout(() => {
      const sel = getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0).cloneRange();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      this.updateCustomCaret();
    }, 10);
    setTimeout(() => this.updateCustomCaret(), 100);
  }

  placeCaretAtEnd(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    node.closest('.page-content')?.focus();
  }

  updateFormatLabel(type = null) {
    const block = this.currentBlockElement();
    const resolved = type || (block?.tagName?.toLowerCase() === 'h2' ? 'heading' : block?.tagName?.toLowerCase() === 'blockquote' ? 'quote' : 'paragraph');
    const label = { paragraph: 'Обычный текст', heading: 'Заголовок', quote: 'Цитата' }[resolved] || 'Обычный текст';
    const labelEl = document.getElementById('format-label');
    if (labelEl) labelEl.textContent = label;
  }

  updateToolbarState() {
    const paneId = this.selectionSnapshot?.paneId || this.state.workspace?.focusedPaneId || 'primary';
    const editor = this.nocturneEditor?.get(paneId);
    if (editor) {
      const states = {
        bold: editor.isActive('bold'),
        italic: editor.isActive('italic'),
        underline: editor.isActive('underline'),
        strikeThrough: editor.isActive('strike'),
        justifyLeft: editor.isActive({ textAlign: 'left' }) || !['center', 'justify'].some((align) => editor.isActive({ textAlign: align })),
        justifyCenter: editor.isActive({ textAlign: 'center' }),
        justifyFull: editor.isActive({ textAlign: 'justify' }),
      };
      Object.entries(states).forEach(([command, active]) => {
        document.querySelectorAll(`[data-command="${command}"]`).forEach((button) => button.classList.toggle('active', !!active));
      });
      this.updateFormatLabel(editor.isActive('heading') ? 'heading' : editor.isActive('blockquote') ? 'quote' : 'paragraph');
      return;
    }
    ['bold', 'italic', 'justifyLeft', 'justifyCenter', 'justifyFull'].forEach((command) => {
      const button = document.querySelector(`[data-command="${command}"]`);
      const block = this.currentBlockElement();
      const alignState = command === 'justifyLeft' ? block?.style.textAlign === 'left' || !block?.style.textAlign
        : command === 'justifyCenter' ? block?.style.textAlign === 'center'
          : command === 'justifyFull' ? block?.style.textAlign === 'justify'
            : this.currentSelectionHasInline(command === 'bold' ? 'strong' : command === 'italic' ? 'em' : '');
      button?.classList.toggle('active', !!alignState);
    });
    this.updateFormatLabel();
  }

  currentSelectionHasInline(tagName) {
    if (!tagName) return false;
    if (this.selectionController?.active && this.selectionController.range) {
      return this.selectionFullyMarked(this.selectionController.range, tagName);
    }
    const sel = getSelection();
    if (!sel?.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      const node = sel.anchorNode?.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode?.parentElement;
      return !!node?.closest?.(tagName);
    }
    return this.selectionFullyMarked(range, tagName);
  }

  handleInput(event) {
    const editable = event.target.closest?.('.page-content');
    if (editable) {
      if (this.nocturneEditor?.getByElement(event.target)) return;
      if (this.state.reviewMode === 'editor') return;
      this.hideEntityHoverCards();
      this.removeSoftEmptyLinePlaceholders(editable);
      this.clearSoftEmptyLineIfStale(editable);
      this.editorInput(editable, event);
    }
    if (event.target.id === 'notes-input') this.saveCurrentNote();
    if (event.target.matches('[data-mobile-doc-search]')) {
      this.state.mobile.docsSearch = event.target.value;
      this.renderMobileShell();
      return;
    }
    if (event.target.matches('[data-mobile-lore-search]')) {
      this.state.mobile.loreSearch = event.target.value;
      this.renderMobileShell();
      return;
    }
    if (event.target.matches('[data-mobile-notes-input]')) {
      const mode = this.state.mobile.notesMode || this.state.noteMode;
      if (mode === 'global') {
        this.state.globalNotes = event.target.value;
        if (!this.state.settings.e2e) safeSetStorageItem(localStorage, 'nocturne-global-notes', this.state.globalNotes);
      } else {
        const doc = this.getFocusedDoc();
        if (doc) {
          doc.notes = event.target.value;
          doc.updatedAt = Date.now();
          this.writeLiveDraft(doc.id);
          this.saveDocByIdDebounced(doc.id);
        }
      }
    }
    if (event.target.matches('[data-sync-field]')) {
      const key = event.target.dataset.syncField;
      this.state.sync[key] = event.target.value;
      if (key === 'deviceName') safeSetStorageItem(localStorage, 'nocturne-sync-device-name', event.target.value);
      if (key === 'host') safeSetStorageItem(localStorage, 'nocturne-sync-host', event.target.value);
      if (key === 'port') safeSetStorageItem(localStorage, 'nocturne-sync-port', event.target.value);
      if (key === 'token') safeSetStorageItem(localStorage, 'nocturne-sync-token', event.target.value);
    }
    const floatingEditable = event.target.closest?.('[data-floating-field]');
    if (floatingEditable) this.handleFloatingNoteInput(floatingEditable);
    if (event.target.matches('[data-accent-hex], [data-accent-native]')) {
      this.handleAccentInput(event.target);
      return;
    }
    if (event.target.matches('[data-setting]')) this.updateSettingFromControl(event.target);
    if (event.target.matches('[data-dictionary-search]')) {
      this.state.dictionarySearch = event.target.value;
      this.updateDictionarySearchList();
    }
    if (event.target.id === 'settings-search-field') {
      this.state.settingsSearchQuery = event.target.value;
      this.updateSettingsSearchList();
    }
    if (event.target.matches('[data-doc-search-query]')) {
      if (!this.searchSession) return;
      this.searchSession.query = event.target.value;
      this.refreshSearchSession();
    }
    if (event.target.matches('[data-command-palette-input]')) {
      this.commandPalette.setQuery(event.target.value);
    }
    if (event.target.matches('[data-global-search-query]')) {
      this.globalSearchState.query = event.target.value;
      this.runGlobalSearch();
    }
    if (event.target.matches('[data-replace-find], [data-replace-with]')) {
      this.updateReplaceFromControls();
    }
  }

  handleSearchOptionChange(event) {
    if (event.target.matches('[data-doc-search-case], [data-doc-search-whole]')) {
      if (!this.searchSession) return false;
      this.searchSession.caseSensitive = !!document.querySelector('[data-doc-search-case]')?.checked;
      this.searchSession.wholeWords = !!document.querySelector('[data-doc-search-whole]')?.checked;
      this.refreshSearchSession();
      return true;
    }
    if (event.target.matches('[data-global-search-case], [data-global-search-whole]')) {
      this.globalSearchState.caseSensitive = !!document.querySelector('[data-global-search-case]')?.checked;
      this.globalSearchState.wholeWords = !!document.querySelector('[data-global-search-whole]')?.checked;
      this.runGlobalSearch();
      return true;
    }
    if (event.target.matches('[data-replace-option]')) {
      this.updateReplaceFromControls();
      return true;
    }
    return false;
  }

  handleFocusOut(event) {
    const title = event.target.closest?.('[data-floating-title][contenteditable="true"]');
    if (title) this.commitFloatingNoteRename(title);
    window.setTimeout(() => this.handleMobileViewportChange(), 80);
  }

  handleBeforeInput(event) {
    const editable = event.target.closest?.('.page-content');
    if (!editable) return;
    if (this.nocturneEditor?.getByElement(event.target)) {
      if (this.state.reviewMode === 'editor') event.preventDefault();
      return;
    }
    if (this.state.reviewMode === 'editor') {
      event.preventDefault();
      return;
    }
    if (this.consumeSoftEmptyLineInput(editable, event)) return;
    if (event.inputType === 'insertLineBreak') {
      event.preventDefault();
      if (this.handledSoftBreakRecently) return;
      this.insertSoftLineBreak(editable);
      return;
    }
    if (event.inputType === 'deleteContentBackward') {
      this.normalizeEditable(editable);
      if (this.handleSoftEmptyLineBackspace(editable, event)) return;
      if (this.handleBackspaceAfterSoftBreak(editable, event)) return;
    }
  }

  handlePaste(event) {
    const editable = event.target.closest?.('.page-content');
    if (editable) {
      if (this.nocturneEditor?.getByElement(event.target)) {
        if (this.state.reviewMode === 'editor') event.preventDefault();
        return;
      }
      event.preventDefault();
      if (this.state.reviewMode === 'editor') return;
      const text = event.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      this.insertPlainTextPaste(editable, text);
      this.editorInput(editable, { inputType: 'insertFromPaste' });
      // Paginate immediately for large pastes to prevent missing content
      const paneId = editable.dataset.paneId || this.state.workspace?.focusedPaneId || 'primary';
      if (text.length > 500) {
        const snapshot = this.getCaretSnapshot();
        this.renderEditor(paneId);
        this.restoreCaret(snapshot);
      } else {
        this.repaginatePreserve(paneId);
      }
      return;
    }
    const field = event.target.closest?.('[data-floating-field]');
    if (!field) return;
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') || '';
    this.insertTextAtSelection(text, field);
  }

  insertTextAtSelection(text, container = document.activeElement) {
    const sel = getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !container?.contains?.(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(container);
      range.collapse(false);
    }
    range.deleteContents();
    const node = document.createTextNode(String(text || ''));
    range.insertNode(node);
    range.setStart(node, node.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  insertPlainTextPaste(editable, text) {
    this.normalizeEditable(editable);
    const sel = getSelection();
    if (!sel?.rangeCount) return;
    const block = this.blockForSelection(editable);
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const normalized = String(text || '').replace(/\r\n?/g, '\n');
    const paragraphs = normalized.split(/\n{2,}/).map((part) => part.replace(/\n/g, '\n')).filter((part) => part.length);
    if (paragraphs.length <= 1 || !block) {
      const node = document.createTextNode(paragraphs[0] || normalized);
      range.insertNode(node);
      const next = document.createRange();
      next.setStart(node, node.length);
      next.collapse(true);
      sel.removeAllRanges();
      sel.addRange(next);
      return;
    }
    const tail = document.createRange();
    tail.setStart(range.endContainer, range.endOffset);
    tail.setEnd(block, block.childNodes.length);
    const tailFragment = tail.extractContents();
    const first = document.createTextNode(paragraphs[0]);
    range.insertNode(first);
    let ref = block;
    paragraphs.slice(1).forEach((paragraph) => {
      const nextBlock = this.createEditorBlock('paragraph');
      nextBlock.textContent = paragraph;
      ref.after(nextBlock);
      ref = nextBlock;
    });
    ref.appendChild(tailFragment);
    this.ensureEditableBlockContent(block);
    this.ensureEditableBlockContent(ref);
    this.placeCaretAtEnd(ref);
  }

  handleDoubleClick(event) {
    const title = event.target.closest?.('[data-floating-title]');
    if (!title) return;
    event.preventDefault();
    this.beginFloatingNoteRename(title);
  }

  handleChange(event) {
    if (event.target.matches('[data-setting]')) this.updateSettingFromControl(event.target);
    if (event.target.id === 'import-input') this.importDocuments(event.target.files);
        if (event.target.id === 'custom-font-uploader') {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = () => {
          const fontName = file.name.split('.')[0].replace(/[^a-zA-Z0-9\s-_]/g, '').trim();
          this.state.settings.customFonts = this.state.settings.customFonts || [];
          if (this.state.settings.customFonts.some(f => f.name === fontName)) {
            this.toast('Шрифт с таким именем уже загружен.');
            return;
          }
          this.state.settings.customFonts.push({
            name: fontName,
            data: reader.result
          });
          this.persistSettings();
          this.injectCustomFonts();
          this.renderSettings();
          this.toast(`Шрифт "${fontName}" загружен.`);
        };
        reader.readAsDataURL(file);
      }
    }
    if (event.target.closest?.('#notes-input') && event.target.matches('input[type="checkbox"]')) this.saveCurrentNote();
    this.handleSearchOptionChange(event);
  }

    getLayoutIndependentKey(event) {
    if (!event.code) return event.key;
    if (event.code.startsWith('Key')) {
      return event.code.slice(3).toLowerCase();
    }
    if (event.code.startsWith('Digit')) {
      return event.code.slice(5);
    }
    const codeMap = {
      'Minus': '-',
      'Equal': '=',
      'BracketLeft': '[',
      'BracketRight': ']',
      'Semicolon': ';',
      'Quote': "'",
      'Comma': ',',
      'Period': '.',
      'Slash': '/',
      'Backquote': '`',
      'Backslash': '\\',
    };
    if (codeMap[event.code]) return codeMap[event.code];
    return event.key;
  }

  handleKeydown(event) {
    const keyName = this.getLayoutIndependentKey(event).toUpperCase();
    this.currentlyPressedKeys = this.currentlyPressedKeys || new Set();
    this.currentlyPressedKeys.add(keyName);

    if (this.macroRecordingState) {
      event.preventDefault();
      event.stopPropagation();
      this.recordedHeldKeys = this.recordedHeldKeys || new Set();
      this.recordedHeldKeys.add(keyName);
      
      const parts = [];
      if (event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');
      if (event.metaKey) parts.push('Meta');
      
      this.recordedHeldKeys.forEach((k) => {
        if (!['CONTROL', 'ALT', 'SHIFT', 'META'].includes(k)) {
          parts.push(k);
        }
      });
      this.macroRecordedKeys = parts.join(' + ');
      
      const inputEl = document.getElementById('new-macro-keys');
      if (inputEl) {
        inputEl.value = this.macroRecordedKeys;
      }
      const warningEl = document.getElementById('macro-conflict-warning');
      if (warningEl) {
        const conflict = this.checkMacroConflict(this.macroRecordedKeys);
        warningEl.textContent = conflict || '';
        warningEl.style.display = conflict ? 'block' : 'none';
      }
      return;
    }

    const macroTarget = event.target;
    const macroEditable = macroTarget?.closest?.('.page-content');
    if (macroEditable && this.isEditable(macroEditable)) {
      if (this.triggerKeyboardMacro(event, macroEditable)) {
        return;
      }
    }

    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && this.getLayoutIndependentKey(event).toLowerCase() === 'k') {
      event.preventDefault();
      this.commandPalette.toggle();
      return;
    }
    if (this.commandPalette.handleKeydown(event)) return;
    if (event.key === 'Control' || event.key === 'Meta' || event.ctrlKey || event.metaKey) {
      this.ctrlPressed = true;
      document.body.classList.add('ctrl-pressed');
      if (this.hoveredEntityLink) this.showEntityHoverCard(this.hoveredEntityLink);
    }
    if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !this.isTypingSurface(event.target)) {
      event.preventDefault();
      this.openShortcutsModal();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && this.getLayoutIndependentKey(event).toLowerCase() === 'f') {
      event.preventDefault();
      if (event.shiftKey) this.openGlobalSearchWindow();
      else this.openDocumentSearch();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && this.getLayoutIndependentKey(event).toLowerCase() === 'h') {
      event.preventDefault();
      this.openReplaceWindow();
      return;
    }
    const floatingTitle = event.target.closest?.('[data-floating-title][contenteditable="true"]');
    if (floatingTitle && event.key === 'Enter') {
      event.preventDefault();
      this.commitFloatingNoteRename(floatingTitle);
      floatingTitle.blur();
      return;
    }
    if (floatingTitle && event.key === 'Escape') {
      event.preventDefault();
      this.cancelFloatingNoteRename(floatingTitle);
      floatingTitle.blur();
      return;
    }
    const focusedEntity = event.target.closest?.('.entity-link');
    if (focusedEntity && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      this.openEntityLinkDetail(focusedEntity);
      return;
    }
    if (event.key === 'Shift') this.shiftKeyDown = true;
    if (event.key === 'Escape') {
      if (this.closeTopMobileOverlay()) {
        event.preventDefault();
        return;
      }
      this.hideEntityHoverCards();
      this.closeAllFloatingMenus();
      this.closeSettingsSelects();
      this.closeShortcutsModal();
      this.hideSettingsTooltip(true);
      document.querySelectorAll('#form-overlay.active, #settings-overlay.active, #kb-modal.active').forEach((modal) => modal.classList.remove('active'));
      if (this.state.activeSubtimelineId) this.closeSubtimeline();
    }
        const target = event.target;
    const editable = target.closest?.('.page-content');
    const isTiptap = !!this.nocturneEditor?.getByElement(target);

    if (!isTiptap && editable && this.state.reviewMode === 'editor') {
      const allowed = event.ctrlKey || event.metaKey || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Tab'].includes(event.key);
      if (!allowed) event.preventDefault();
      return;
    }
    if (!isTiptap && editable && event.key === 'Enter') {
      const shiftEnter = event.shiftKey || event.getModifierState?.('Shift') || this.shiftKeyDown;
      if (shiftEnter) {
        event.preventDefault();
        if (!this.handledSoftBreakRecently) this.insertSoftLineBreak(editable);

      } else {
        event.preventDefault();
        const now = Date.now();
        if (this.lastParagraphBreakTime && now - this.lastParagraphBreakTime < 50) return;
        this.lastParagraphBreakTime = now;

        this.insertParagraphBreak(editable);
      }
      return;
    }
    if (!isTiptap && editable && (event.key === 'Backspace' || event.key === 'Delete')) {
      if (this.handlePageBoundaryDeletion(editable, event)) return;
      if (event.key === 'Delete' && this.handleEditorDeleteKey(editable, event)) return;
      if (event.key === 'Backspace' && this.handleEmptyEditorBackspace(editable, event)) return;
    }
    if (editable && this.isEditable(editable) && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setTimeout(() => this.spawnLetterAnimation(event.key), 0);
      if (!isTiptap && this.state.settings.smartPunctuation) this.smartPunctuationKey(event);
    }
    if (editable) this.lastEditKey = event.key;
    if ((event.ctrlKey || event.metaKey) && this.getLayoutIndependentKey(event).toLowerCase() === 's') {
      event.preventDefault();
      this.saveActiveDoc();
      this.toast('Сохранено локально.');
    }
  }

  handleKeyup(event) {
    const keyName = this.getLayoutIndependentKey(event).toUpperCase();
    this.currentlyPressedKeys = this.currentlyPressedKeys || new Set();
    this.currentlyPressedKeys.delete(keyName);

    if (this.macroRecordingState) {
      event.preventDefault();
      event.stopPropagation();
      if (this.recordedHeldKeys) {
        this.recordedHeldKeys.delete(keyName);
      }
      return;
    }

    if (event.key === 'Shift') this.shiftKeyDown = false;
    if (event.key === 'Control' || event.key === 'Meta' || (!event.ctrlKey && !event.metaKey)) {
      this.ctrlPressed = false;
      document.body.classList.remove('ctrl-pressed');
    }
  }

  isTypingSurface(target) {
    return !!target?.closest?.('input, textarea, select, [contenteditable="true"], .page-content, .floating-note-body, .floating-note-title, #notes-input');
  }

  openShortcutsModal() {
    this.closeContextMenu();
    const overlay = document.getElementById('shortcuts-overlay');
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="form-modal shortcuts-modal">
        <div class="shortcuts-header">
          <div>
            <h2>Горячие клавиши</h2>
            <p>Только сочетания, которые уже поддерживаются редактором.</p>
          </div>
          <button class="btn-icon" data-action="close-shortcuts"><i class="bx bx-x"></i></button>
        </div>
        <div class="shortcuts-grid">
          ${this.shortcutsGroup('Текст', [
            ['Ctrl', 'B', 'Жирный'],
            ['Ctrl', 'I', 'Курсив'],
            ['Shift', 'Enter', 'Мягкий перенос строки'],
            ['Enter', '', 'Новый абзац'],
            ['Backspace / Delete', '', 'Удалить'],
          ])}
          ${this.shortcutsGroup('Документ', [
            ['Ctrl', 'S', 'Сохранить локально'],
            ['Ctrl', 'F', 'Поиск в текущем документе'],
            ['Ctrl + Shift', 'F', 'Поиск по всем документам'],
            ['Ctrl', 'H', 'Замена в текущем документе'],
          ])}
          ${this.shortcutsGroup('Навигация / интерфейс', [
            ['Ctrl + hover', '', 'Карточка имени или места'],
            ['?', '', 'Открыть это окно'],
            ['Escape', '', 'Закрыть всплывающие окна'],
          ])}
        </div>
      </div>`;
    overlay.classList.add('active');
  }

  shortcutsGroup(title, rows) {
    return `<section class="shortcuts-group">
      <h3>${escapeHtml(title)}</h3>
      ${rows.map(([a, b, label]) => `<div class="shortcut-row">
        <div class="keycaps"><kbd>${escapeHtml(a)}</kbd>${b ? `<span>+</span><kbd>${escapeHtml(b)}</kbd>` : ''}</div>
        <span>${escapeHtml(label)}</span>
      </div>`).join('')}
    </section>`;
  }

  closeShortcutsModal() {
    const overlay = document.getElementById('shortcuts-overlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.innerHTML = '';
  }

  handleContextMenu(event) {
    const editable = event.target.closest?.('.page-content');
    const entity = event.target.closest?.('.entity-link');
    if (!editable && !entity) return;
    if (event.target.closest?.('input, textarea, select, .form-modal, .settings-modal, .floating-note')) return;
    event.preventDefault();
    const sel = getSelection();
    const selectedText = sel?.rangeCount && !sel.isCollapsed ? sel.toString().trim() : '';
    const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    this.contextSelectionRange = range;
    this.closeAllFloatingMenus('context');
    const surface = editable || entity?.closest('.page-content');
    const typoMatch = editable ? this.findTypoMatchAtPoint(event.clientX, event.clientY, editable) : null;
    this.state.contextMenu = {
      x: event.clientX,
      y: event.clientY,
      selectedText,
      paneId: surface?.dataset.paneId || this.state.workspace?.focusedPaneId || 'primary',
      docId: surface?.dataset.docId || this.getFocusedDoc()?.id || null,
      reviewMode: this.state.reviewMode,
      entityPayload: entity ? {
        kind: entity.dataset.entityKind,
        id: entity.dataset.entityId,
        familyName: entity.dataset.familyName,
      } : null,
      typoMatch,
    };
    this.renderContextMenu();
  }

  findTypoMatchAtPoint(x, y, editable) {
    const pointRange = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(x, y)
      : (() => {
        const pos = document.caretPositionFromPoint?.(x, y);
        if (!pos) return null;
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        return range;
      })();
    if (!pointRange || !editable?.contains(pointRange.startContainer)) return null;
    const block = (pointRange.startContainer.nodeType === Node.ELEMENT_NODE ? pointRange.startContainer : pointRange.startContainer.parentElement)?.closest?.('[data-block-id]');
    if (!block) return null;
    const pre = pointRange.cloneRange();
    pre.selectNodeContents(block);
    pre.setEnd(pointRange.startContainer, pointRange.startOffset);
    const offset = Number(block.dataset.fragmentStart || 0) + pre.toString().length;
    const docId = editable.dataset.docId || null;
    const paneId = editable.dataset.paneId || 'primary';
    return this.typoMatchIndex.find((match) => (
      match.docId === docId
      && match.paneId === paneId
      && match.blockId === (block.dataset.sourceBlockId || block.dataset.blockId)
      && offset >= match.startOffset
      && offset <= match.endOffset
    )) || null;
  }

  renderContextMenu() {
    const menu = document.getElementById('app-context-menu');
    const ctx = this.state.contextMenu;
    if (!menu || !ctx) return;
    const hasSelection = !!ctx.selectedText;
    const canEdit = ctx.reviewMode !== 'editor';
    const selectedPreview = hasSelection ? `<div class="context-selection">"${escapeHtml(ctx.selectedText.slice(0, 90))}${ctx.selectedText.length > 90 ? '...' : ''}"</div>` : '';
    const item = (action, icon, label, disabled = false, attrs = '') => `<button class="context-menu-item" data-action="${action}" ${attrs} ${disabled ? 'disabled' : ''}><i class="bx ${icon}"></i><span>${label}</span></button>`;
    const issueItems = ctx.reviewMode === 'editor' && hasSelection ? `
      <div class="context-subtitle">Пометить проблему</div>
      ${item('context-review-issue', 'bx-check-circle', 'Орфография', false, 'data-review-category="orthography"')}
      ${item('context-review-issue', 'bx-brain', 'Логика', false, 'data-review-category="logic"')}
      ${item('context-review-issue', 'bx-git-branch', 'Сюжет / мотивация', false, 'data-review-category="plot"')}
      ${item('context-review-issue', 'bx-bookmark', 'Лор / непрерывность', false, 'data-review-category="continuity"')}
      ${item('context-review-issue', 'bx-water', 'Стиль / ритм', false, 'data-review-category="style"')}
    ` : '';
    const editorBlock = ctx.reviewMode === 'editor' && hasSelection ? `
      ${item('context-review-comment', 'bx-comment-detail', 'Добавить комментарий')}
      ${item('context-review-suggestion', 'bx-transfer-alt', 'Предложить замену')}
      ${issueItems}
      <div class="context-separator"></div>
    ` : '';
    const entityBlock = ctx.entityPayload ? `
      <div class="context-section-title">Сущность</div>
      ${item('context-entity-detail', 'bx-id-card', 'Просмотреть досье')}
      ${item('context-entity-side', 'bx-sidebar', 'Открыть справа')}
      ${item('context-entity-edit', 'bx-edit', 'Редактировать', ctx.entityPayload.kind === 'family')}
      ${item('context-entity-note', 'bx-note', 'Создать заметку', ctx.entityPayload.kind === 'family')}
      <div class="context-separator"></div>
    ` : '';
    const typoBlock = ctx.typoMatch ? `
      <div class="context-section-title">${ctx.typoMatch.source === 'smart' ? 'Smart-словарь: возможная ошибка' : 'Словарь ошибок'}</div>
      ${item('context-apply-typo-replacement', 'bx-check-shield', `Заменить на «${escapeHtml(ctx.typoMatch.correct)}»`)}
      <div class="context-separator"></div>
    ` : '';
    menu.innerHTML = `
      ${selectedPreview}
      ${entityBlock}
      ${typoBlock}
      ${item('context-copy', 'bx-copy', 'Копировать', !hasSelection)}
      ${item('context-cut', 'bx-cut', 'Вырезать', !hasSelection || !canEdit)}
      ${item('context-paste', 'bx-clipboard', 'Вставить', !canEdit)}
      ${hasSelection ? item('context-add-typo-rule', 'bx-book-add', 'Добавить в словарь ошибок') : ''}
      ${editorBlock}
    `;
    menu.classList.add('active');
    menu.setAttribute('aria-hidden', 'false');
    menu.style.pointerEvents = '';
    this.activeFloatingMenuKey = 'context';
    const rect = menu.getBoundingClientRect();
    const x = Math.min(window.innerWidth - rect.width - 12, Math.max(12, ctx.x));
    const y = Math.min(window.innerHeight - rect.height - 12, Math.max(12, ctx.y));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }

  closeContextMenu() {
    const menu = document.getElementById('app-context-menu');
    menu?.classList.remove('active');
    menu?.setAttribute('aria-hidden', 'true');
    if (menu) menu.style.pointerEvents = 'none';
    if (this.activeFloatingMenuKey === 'context') this.activeFloatingMenuKey = '';
    this.state.contextMenu = null;
  }

  restoreContextRange() {
    if (!this.contextSelectionRange) {
      const sel = getSelection();
      return sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    }
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(this.contextSelectionRange.cloneRange());
    const editable = this.contextSelectionRange.commonAncestorContainer?.nodeType === 1
      ? this.contextSelectionRange.commonAncestorContainer.closest?.('.page-content')
      : this.contextSelectionRange.commonAncestorContainer?.parentElement?.closest?.('.page-content');
    editable?.focus();
    return this.contextSelectionRange.cloneRange();
  }

  async handleContextMenuAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const ctx = this.state.contextMenu;
    if (!ctx) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'context-copy') {
      await this.copyTextToClipboard(ctx.selectedText);
    } else if (action === 'context-cut') {
      await this.copyTextToClipboard(ctx.selectedText);
      const range = this.restoreContextRange();
      if (range && this.state.reviewMode !== 'editor') {
        range.deleteContents();
        const editable = range.commonAncestorContainer?.parentElement?.closest?.('.page-content')
          || document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(ctx.paneId || 'primary')}"] .page-content[data-doc-id="${CSS.escape(ctx.docId || '')}"]`);
        if (editable) this.editorInput(editable, { inputType: 'deleteByCut' });
      }
    } else if (action === 'context-paste') {
      await this.pasteClipboardAtContext();
    } else if (action === 'context-add-typo-rule') {
      this.closeContextMenu();
      this.openTypoRuleForm(ctx.selectedText);
      return;
    } else if (action === 'context-apply-typo-replacement') {
      if (this.applyTypoReplacement(ctx.typoMatch)) this.toast(`Заменено на «${ctx.typoMatch.correct}».`);
      this.closeContextMenu();
      return;
    } else if (action === 'context-review-comment') {
      this.closeContextMenu();
      this.openReviewCommentForm();
      return;
    } else if (action === 'context-review-suggestion') {
      this.closeContextMenu();
      this.openReviewSuggestionForm();
      return;
    } else if (action === 'context-review-issue') {
      await this.createReviewMarkFromSelection('issue', button.dataset.reviewCategory || 'style');
    } else if (action.startsWith('context-entity')) {
      this.runEntityContextAction(action, ctx.entityPayload);
    }
    this.closeContextMenu();
  }

  async copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text || '');
    } catch {
      this.toast('Буфер обмена недоступен — используйте Ctrl+C.');
    }
  }

  async pasteClipboardAtContext() {
    try {
      const text = await navigator.clipboard.readText();
      const range = this.restoreContextRange();
      if (!range) return;
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const editable = range.commonAncestorContainer?.parentElement?.closest?.('.page-content') || document.querySelector('.page-content:focus');
      if (editable) this.editorInput(editable, { inputType: 'insertFromPaste' });
    } catch {
      this.toast('Буфер обмена недоступен — используйте Ctrl+V.');
    }
  }

  runEntityContextAction(action, payload) {
    if (!payload || payload.kind === 'family') return;
    const loreType = payload.kind === 'location' ? 'locations' : 'characters';
    if (action === 'context-entity-detail') this.openLoreDetail(payload.kind, payload.id);
    if (action === 'context-entity-side') this.openSecondaryPane({ type: `${payload.kind}-detail`, entityType: payload.kind, entityId: payload.id });
    if (action === 'context-entity-edit') this.editLore(loreType, payload.id);
    if (action === 'context-entity-note') this.createFloatingNote({ scope: payload.kind, linkedId: payload.id, title: 'Заметка к досье', forceVisible: true });
  }

  handlePointerDown(event) {
    const floatingNote = event.target.closest?.('.floating-note');
    if (floatingNote) this.bringFloatingNoteToFront(floatingNote.dataset.noteId, { render: false });
    const resizer = event.target.closest?.('.floating-note-resizer');
    if (resizer) {
      this.startFloatingNoteResize(event, resizer.closest('.floating-note'));
      return;
    }
    const header = event.target.closest?.('.floating-note-header');
    if (header && !event.target.closest('button, [contenteditable="true"], input, textarea')) {
      this.startFloatingNoteDrag(event, header.closest('.floating-note'));
      return;
    }
    if (!event.target.closest?.('#workspace-divider')) return;
    event.preventDefault();
    const stage = document.getElementById('workspace-stage');
    if (!stage || this.state.workspace.mode !== 'split') return;
    const rect = stage.getBoundingClientRect();
    document.body.classList.add('resizing-workspace');
    const move = (moveEvent) => {
      const ratio = (moveEvent.clientX - rect.left) / Math.max(1, rect.width);
      this.state.workspace.splitRatio = Math.min(.78, Math.max(.32, ratio));
      stage.style.setProperty('--split-primary', `${this.state.workspace.splitRatio * 100}%`);
      stage.style.setProperty('--split-secondary', `${(1 - this.state.workspace.splitRatio) * 100}%`);
    };
    const up = () => {
      document.body.classList.remove('resizing-workspace');
      this.persistWorkspaceState();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  handleEntityMouseOver(event) {
    if (event.target.closest?.('#entity-preview-card')) {
      this.entityPreviewHovered = true;
      clearTimeout(this.entityHoverHideTimer);
      return;
    }
    if (event.target.closest?.('#entity-hover-card')) {
      this.entityPopupHovered = true;
      clearTimeout(this.entityHoverHideTimer);
    }
    const familyMember = event.target.closest?.('[data-family-member-id]');
    if (familyMember) {
      this.showEntityPreviewCard(familyMember);
      return;
    }
    const link = event.target.closest?.('.entity-link');
    if (!link) return;
    this.entityAnchorHovered = true;
    this.hoveredEntityLink = link;
    if (this.ctrlPressed || event.ctrlKey || event.metaKey) this.showEntityHoverCard(link);
  }

  handleEntityMouseMove(event) {
    if (event.target.closest?.('#entity-hover-card')) this.entityPopupHovered = true;
    if (event.target.closest?.('#entity-preview-card')) this.entityPreviewHovered = true;
    const link = event.target.closest?.('.entity-link');
    if (!link) return;
    this.entityAnchorHovered = true;
    this.hoveredEntityLink = link;
    if (this.ctrlPressed || event.ctrlKey || event.metaKey) this.showEntityHoverCard(link);
  }

  handleEntityMouseOut(event) {
    const fromEntitySurface = event.target.closest?.('.entity-link, #entity-hover-card, #entity-preview-card, [data-family-member-id]');
    if (!fromEntitySurface) return;
    const toEntitySurface = event.relatedTarget?.closest?.('.entity-link, #entity-hover-card, #entity-preview-card, [data-family-member-id]');
    if (toEntitySurface && fromEntitySurface === toEntitySurface) return;
    if (fromEntitySurface.classList?.contains('entity-link')) this.entityAnchorHovered = false;
    if (fromEntitySurface.id === 'entity-hover-card' || fromEntitySurface.closest?.('#entity-hover-card')) this.entityPopupHovered = false;
    if (fromEntitySurface.id === 'entity-preview-card' || fromEntitySurface.closest?.('#entity-preview-card')) this.entityPreviewHovered = false;
    if (toEntitySurface) return;
    this.hoveredEntityLink = null;
    this.scheduleHideEntityHoverCards();
  }

  scheduleHideEntityHoverCards() {
    clearTimeout(this.entityHoverHideTimer);
    this.entityHoverHideTimer = setTimeout(() => {
      if (!this.entityAnchorHovered && !this.entityPopupHovered && !this.entityPreviewHovered) this.hideEntityHoverCards();
    }, 220);
  }

  hideEntityHoverCards() {
    clearTimeout(this.entityHoverHideTimer);
    this.entityAnchorHovered = false;
    this.entityPopupHovered = false;
    this.entityPreviewHovered = false;
    this.activeEntityHoverKey = '';
    ['entity-hover-card', 'entity-preview-card'].forEach((id) => {
      const card = document.getElementById(id);
      if (!card) return;
      card.classList.remove('active');
      card.setAttribute('aria-hidden', 'true');
    });
  }

  showEntityHoverCard(link) {
    if (!link) return;
    clearTimeout(this.entityHoverHideTimer);
    const card = document.getElementById('entity-hover-card');
    if (!card) return;
    const payload = this.entityPayloadFromLink(link);
    if (!payload) return;
    const hoverKey = payload.kind === 'family' ? `family:${payload.familyName}` : `${payload.kind}:${payload.entity.id}`;
    if (this.activeEntityHoverKey !== hoverKey) {
      card.innerHTML = payload.kind === 'family'
        ? this.renderFamilyHoverCard(payload.familyName, payload.members)
        : this.renderEntityHoverCard(payload.entity, payload.kind);
      this.activeEntityHoverKey = hoverKey;
    }
    card.dataset.kind = payload.kind;
    card.classList.add('active');
    card.setAttribute('aria-hidden', 'false');
    this.positionFloatingCard(card, link.getBoundingClientRect());
  }

  showEntityPreviewCard(row) {
    const card = document.getElementById('entity-preview-card');
    const entity = this.state.lore.characters.find((item) => item.id === row.dataset.familyMemberId);
    if (!card || !entity) return;
    card.innerHTML = this.renderEntityPreview(entity);
    card.classList.add('active');
    card.setAttribute('aria-hidden', 'false');
    this.positionFloatingCard(card, row.getBoundingClientRect(), { compact: true });
  }

  entityPayloadFromLink(link) {
    const kind = link.dataset.entityKind;
    if (kind === 'family') {
      const familyName = link.dataset.familyName || link.textContent.trim();
      const key = normalizeTypoToken(familyName);
      const members = this.state.lore.characters.filter((character) => normalizeTypoToken(character.lastName || '') === key);
      return { kind: 'family', familyName, members };
    }
    const collection = kind === 'location' ? this.state.lore.locations : this.state.lore.characters;
    const entity = collection.find((item) => item.id === link.dataset.entityId);
    return entity ? { kind, entity } : null;
  }

  renderEntityHoverCard(entity, kind) {
    const label = kind === 'location' ? 'Локация' : 'Персонаж';
    const icon = entity.image ? `<img src="${entity.image}" alt="">` : `<i class="bx ${entity.icon || (kind === 'location' ? 'bx-buildings' : 'bx-user')}"></i>`;
    return `
      <div class="entity-hover-head">
        <div class="entity-hover-avatar">${icon}</div>
        <div>
          <div class="entity-chip">${label}</div>
          <h3>${escapeHtml(this.entityDisplayName(entity))}</h3>
          <p>${escapeHtml(entity.role || '')}</p>
        </div>
      </div>
      <p class="entity-hover-body">${escapeHtml(entity.body || 'Описание пока не заполнено.')}</p>
      ${entity.aliases?.length ? `<div class="entity-mini-row">${entity.aliases.slice(0, 4).map((alias) => `<span>${escapeHtml(alias)}</span>`).join('')}</div>` : ''}
      <div class="entity-hover-actions">
        <button type="button" data-action="open-lore-detail" data-entity-kind="${kind}" data-entity-id="${entity.id}">${kind === 'location' ? 'Открыть карточку' : 'Открыть досье'}</button>
        <button type="button" data-action="open-lore-side" data-entity-kind="${kind}" data-entity-id="${entity.id}">Открыть справа</button>
        <button type="button" data-action="edit-lore" data-lore-type="${kind === 'location' ? 'locations' : 'characters'}" data-lore-id="${entity.id}">Редактировать</button>
      </div>
    `;
  }

  renderFamilyHoverCard(familyName, members) {
    return `
      <div class="entity-family-head">
        <div class="entity-chip">Фамилия</div>
        <h3>Семья ${escapeHtml(familyName)}</h3>
      </div>
      <div class="entity-family-list">
        ${members.map((member) => {
          const icon = member.image ? `<img src="${member.image}" alt="">` : `<i class="bx ${member.icon || 'bx-user'}"></i>`;
          return `<button type="button" class="entity-family-row" data-family-member-id="${member.id}" data-action="open-lore-detail" data-entity-kind="character" data-entity-id="${member.id}">
            <span class="entity-family-avatar">${icon}</span>
            <span><strong>${escapeHtml(this.entityDisplayName(member))}</strong><small>${escapeHtml(member.role || '')}</small></span>
          </button>`;
        }).join('')}
      </div>
    `;
  }

  renderEntityPreview(entity) {
    return `
      <div class="entity-chip">Превью</div>
      <h3>${escapeHtml(this.entityDisplayName(entity))}</h3>
      <p class="entity-preview-role">${escapeHtml(entity.role || '')}</p>
      <p class="entity-hover-body">${escapeHtml(entity.body || 'Описание пока не заполнено.')}</p>
      <div class="entity-hover-actions">
        <button type="button" data-action="open-lore-detail" data-entity-kind="character" data-entity-id="${entity.id}">Открыть досье</button>
      </div>
    `;
  }

  positionFloatingCard(card, anchorRect, options = {}) {
    const gap = 12;
    const maxLeft = window.innerWidth - card.offsetWidth - gap;
    const maxTop = window.innerHeight - card.offsetHeight - gap;
    let left = anchorRect.right + gap;
    let top = anchorRect.top;
    if (left > maxLeft) left = anchorRect.left - card.offsetWidth - gap;
    if (top > maxTop) top = anchorRect.bottom - card.offsetHeight;
    if (options.compact && left < gap) left = anchorRect.right + gap;
    card.style.left = `${Math.max(gap, Math.min(maxLeft, left))}px`;
    card.style.top = `${Math.max(gap, Math.min(maxTop, top))}px`;
  }

  openEntityLinkDetail(link) {
    const payload = this.entityPayloadFromLink(link);
    if (!payload || payload.kind === 'family') return;
    this.openLoreDetail(payload.kind, payload.entity.id);
  }

  insertSoftLineBreak(editable) {
    this.handledSoftBreakRecently = true;
    clearTimeout(this.softBreakFlagTimer);
    this.softBreakFlagTimer = setTimeout(() => { this.handledSoftBreakRecently = false; }, 180);
    const sel = getSelection();
    if (!sel?.rangeCount) return;
    this.normalizeEditable(editable);
    const block = this.blockForSelection(editable);
    if (block && !this.selectionInsideBlock(block)) this.placeCaretAtStart(block);
    this.removeSoftEmptyLineMarkers(editable);
    let range = getSelection().getRangeAt(0);
    let insertionOffset = block ? this.caretOffsetInBlock(block, range) : null;
    range.deleteContents();

    const lineBreak = document.createTextNode('\n');
    range.insertNode(lineBreak);

    const nextRange = document.createRange();
    nextRange.setStart(lineBreak, lineBreak.length);
    nextRange.collapse(true);
    const nextSelection = getSelection();
    nextSelection.removeAllRanges();
    nextSelection.addRange(nextRange);
    if (block && insertionOffset !== null) {
      const nextOffset = insertionOffset + 1;
      if (this.isEmptySoftLineAtOffset(block, nextOffset)) this.softEmptyLine = { blockId: block.dataset.blockId, offset: nextOffset };
      else this.softEmptyLine = null;
      this.editorInput(editable, { inputType: 'insertLineBreak' });
      this.placeCaretAtBlockOffset(block, nextOffset);
    } else {
      this.editorInput(editable, { inputType: 'insertLineBreak' });
    }
    this.updateCustomCaret();
    
  }

  insertParagraphBreak(editable) {
    let block = null;
    try {
      const sel = getSelection();
      if (!sel?.rangeCount) return;
      this.normalizeEditable(editable);
      const range = sel.getRangeAt(0);
      if (!range.collapsed) range.deleteContents();
      this.normalizeEditable(editable);
      block = this.blockForSelection(editable);
      if (!block || !editable.contains(block)) {
        const fallback = this.createEditorBlock('paragraph');
        editable.appendChild(fallback);
        this.placeCaretAtStart(fallback);
        this.editorInput(editable, { inputType: 'insertLineBreak' });
        return;
      }
      if (!this.selectionInsideBlock(block)) this.placeCaretAtStart(block);

      // Break out of an empty blockquote back to a normal paragraph
      if (block.matches('blockquote') && !this.blockPlainText(block)) {
        const para = this.createEditorBlock('paragraph');
        para.style.textAlign = block.style.textAlign || 'left';
        block.after(para);
        block.remove();
        this.placeCaretAtStart(para);
        this.editorInput(editable, { inputType: 'insertLineBreak' });
        return;
      }

      const activeRange = getSelection().getRangeAt(0);
      const tail = activeRange.cloneRange();
      tail.selectNodeContents(block);
      tail.setStart(activeRange.endContainer, activeRange.endOffset);
      const fragment = tail.extractContents();
      const newType = block.matches('blockquote') ? 'quote' : 'paragraph';
      const newBlock = this.createEditorBlock(newType);
      newBlock.style.textAlign = block.style.textAlign || 'left';
      newBlock.appendChild(fragment);
      if (block.matches('h1,h2,h3') && !this.blockPlainText(newBlock)) newBlock.innerHTML = '<br>';
      this.ensureEditableBlockContent(block);
      this.ensureEditableBlockContent(newBlock);
      block.after(newBlock);
      this.placeCaretAtStart(newBlock);
      this.editorInput(editable, { inputType: 'insertLineBreak' });
    } catch (err) {
      console.warn('[insertParagraphBreak] error:', err);
      try {
        const fallback = this.createEditorBlock('paragraph');
        if (block && editable.contains(block)) {
          block.after(fallback);
        } else {
          editable.appendChild(fallback);
        }
        this.placeCaretAtStart(fallback);
        this.editorInput(editable, { inputType: 'insertLineBreak' });
      } catch (e2) { /* silent */ }
    }
  }

  editableForPane(paneId) {
    const paneEl = document.querySelector(`.workspace-pane[data-pane-id="${paneId}"]`);
    return paneEl?.querySelector('.page-content');
  }

  findBlockNodeInPane(paneId, blockId) {
    const paneEl = document.querySelector(`.workspace-pane[data-pane-id="${paneId}"]`);
    if (!paneEl) return null;
    return paneEl.querySelector(`[data-source-block-id="${blockId}"], #${blockId}`);
  }

  handlePageBoundaryDeletion(editable, event) {
    this.normalizeEditable(editable);
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const range = sel.getRangeAt(0);
    const blockNode = this.blockForSelection(editable);
    if (!blockNode || !editable.contains(blockNode)) return false;

    if (event.key === 'Backspace') {
      if (blockNode !== editable.firstElementChild) return false;
      const offset = this.caretOffsetInBlock(blockNode, range);
      if (offset !== 0) return false;

      event.preventDefault();

      const paneId = editable.dataset.paneId || 'primary';
      const doc = this.getDocForPane(paneId) || this.activeDoc;
      if (!doc || !doc.ast?.blocks) return true;

      const currentBlockId = blockNode.dataset.sourceBlockId || blockNode.id;
      const currentBlockIndex = doc.ast.blocks.findIndex(b => b.id === currentBlockId);
      if (currentBlockIndex <= 0) return true; // No previous block in entire document!

      const prevBlock = doc.ast.blocks[currentBlockIndex - 1];
      const currentBlock = doc.ast.blocks[currentBlockIndex];

      const prevText = this.blockPlainText(prevBlock);

      let mergedHtml = prevBlock.html;
      if (mergedHtml === '<br>') mergedHtml = '';
      let additionHtml = currentBlock.html;
      if (additionHtml === '<br>') additionHtml = '';

      prevBlock.html = mergedHtml + additionHtml;
      if (!prevBlock.html) prevBlock.html = '<br>';

      doc.ast.blocks.splice(currentBlockIndex, 1);
      doc.updatedAt = Date.now();
      this.writeLiveDraft(doc.id);
      this.saveDocByIdDebounced(doc.id);

      this.renderEditor(paneId);

      const nextBlockNode = this.findBlockNodeInPane(paneId, prevBlock.id);
      if (nextBlockNode) {
        this.placeCaretAtBlockOffset(nextBlockNode, prevText.length);
      }

      this.editorInput(this.editableForPane(paneId), { inputType: 'deleteContentBackward' });
      return true;
    }

    if (event.key === 'Delete') {
      if (blockNode !== editable.lastElementChild) return false;
      const offset = this.caretOffsetInBlock(blockNode, range);
      const textLength = this.blockPlainText(blockNode).length;
      if (offset !== textLength) return false;

      event.preventDefault();

      const paneId = editable.dataset.paneId || 'primary';
      const doc = this.getDocForPane(paneId) || this.activeDoc;
      if (!doc || !doc.ast?.blocks) return true;

      const currentBlockId = blockNode.dataset.sourceBlockId || blockNode.id;
      const currentBlockIndex = doc.ast.blocks.findIndex(b => b.id === currentBlockId);
      if (currentBlockIndex < 0 || currentBlockIndex >= doc.ast.blocks.length - 1) return true; // No next block!

      const nextBlock = doc.ast.blocks[currentBlockIndex + 1];
      const currentBlock = doc.ast.blocks[currentBlockIndex];

      const currentText = this.blockPlainText(currentBlock);

      let mergedHtml = currentBlock.html;
      if (mergedHtml === '<br>') mergedHtml = '';
      let additionHtml = nextBlock.html;
      if (additionHtml === '<br>') additionHtml = '';

      currentBlock.html = mergedHtml + additionHtml;
      if (!currentBlock.html) currentBlock.html = '<br>';

      doc.ast.blocks.splice(currentBlockIndex + 1, 1);
      doc.updatedAt = Date.now();
      this.writeLiveDraft(doc.id);
      this.saveDocByIdDebounced(doc.id);

      this.renderEditor(paneId);

      const nextBlockNode = this.findBlockNodeInPane(paneId, currentBlock.id);
      if (nextBlockNode) {
        this.placeCaretAtBlockOffset(nextBlockNode, currentText.length);
      }

      this.editorInput(this.editableForPane(paneId), { inputType: 'deleteContentForward' });
      return true;
    }

    return false;
  }

  handleEditorDeleteKey(editable, event) {
    this.normalizeEditable(editable);
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    return this.handleEmptyEditorBackspace(editable, event);
  }

  handleEmptyEditorBackspace(editable, event) {
    this.normalizeEditable(editable);
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.getRangeAt(0).collapsed) return false;
    const blocks = this.editorBlocks(editable);
    const block = this.blockForSelection(editable);
    if (!block) return false;
    const text = this.blockPlainText(block);
    if (blocks.length === 1 && !text) {
      event.preventDefault();
      this.ensureEditableBlockContent(block);
      this.placeCaretAtStart(block);
      this.editorInput(editable, { inputType: event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward' });
      return true;
    }
    return false;
  }

  handleBackspaceAfterSoftBreak(editable, event) {
    const sel = getSelection();
    if (!sel?.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    const block = this.blockForSelection(editable);
    if (!block || !editable.contains(block)) return false;
    const offset = this.caretOffsetInBlock(block, range);
    if (offset === null || offset <= 0) return false;
    const text = block.textContent || '';
    const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
    if (lineStart <= 0 || offset <= lineStart) return false;
    event.preventDefault();
    const start = this.blockTextPosition(block, offset - 1);
    const end = this.blockTextPosition(block, offset);
    if (!start || !end) return false;
    const deleteRange = document.createRange();
    deleteRange.setStart(start.node, start.offset);
    deleteRange.setEnd(end.node, end.offset);
    deleteRange.deleteContents();
    const afterText = block.textContent || '';
    const nextOffset = offset - 1;
    const afterLineStart = afterText.lastIndexOf('\n', Math.max(0, nextOffset - 1)) + 1;
    const nextLineBreak = afterText.indexOf('\n', nextOffset);
    const afterLineEnd = nextLineBreak === -1 ? afterText.length : nextLineBreak;
    const lineIsNowEmpty = afterLineStart > 0 && afterLineStart === afterLineEnd;
    this.placeCaretAtBlockOffset(block, nextOffset);
    if (lineIsNowEmpty) {
      this.softEmptyLine = { blockId: block.dataset.blockId, offset: nextOffset };
    } else {
      this.softEmptyLine = null;
    }
    this.editorInput(editable, { inputType: 'deleteContentBackward' });
    if (lineIsNowEmpty) {
      this.placeCaretAtBlockOffset(block, nextOffset);
    }
    this.updateCustomCaret();
    
    return true;
  }

  consumeSoftEmptyLineInput(editable, event) {
    if (!this.softEmptyLine) return false;
    if (!['insertText', 'insertCompositionText'].includes(event.inputType) || !event.data) return false;
    const block = this.softEmptyLineBlock(editable);
    if (!block) {
      this.softEmptyLine = null;
      return false;
    }
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && !range.collapsed) return false;
    const caretOffset = range ? this.caretOffsetInBlock(block, range) : null;
    const caretIsOnSoftLine = this.isCaretOnSoftEmptyLine(block, caretOffset);
    if (!caretIsOnSoftLine) {
      this.clearSoftEmptyLineIfStale(editable);
      return false;
    }
    const insertOffset = this.softEmptyLine.offset;
    const insertPos = this.blockTextPosition(block, insertOffset);
    if (!insertPos) {
      this.softEmptyLine = null;
      return false;
    }

    event.preventDefault();
    const textNode = document.createTextNode(event.data);
    const insertRange = document.createRange();
    insertRange.setStart(insertPos.node, insertPos.offset);
    insertRange.collapse(true);
    insertRange.insertNode(textNode);
    this.softEmptyLine = null;
    this.placeCaretAtBlockOffset(block, insertOffset + event.data.length);
    this.editorInput(editable, { inputType: event.inputType, data: event.data });
    this.updateCustomCaret();
    
    return true;
  }

  handleSoftEmptyLineBackspace(editable, event) {
    if (!this.softEmptyLine) return false;
    const block = this.softEmptyLineBlock(editable);
    if (!block) {
      this.softEmptyLine = null;
      return false;
    }
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && !range.collapsed) return false;
    const caretOffset = range ? this.caretOffsetInBlock(block, range) : null;
    const offset = this.softEmptyLine.offset;
    const caretIsOnSoftLine = this.isCaretOnSoftEmptyLine(block, caretOffset);
    if (!caretIsOnSoftLine) {
      this.clearSoftEmptyLineIfStale(editable);
      return false;
    }
    if (offset <= 0) return false;
    const text = block.textContent || '';
    if (text[offset - 1] !== '\n') {
      this.softEmptyLine = null;
      return false;
    }

    event.preventDefault();
    const start = this.blockTextPosition(block, offset - 1);
    const end = this.blockTextPosition(block, offset);
    if (!start || !end) return false;
    const deleteRange = document.createRange();
    deleteRange.setStart(start.node, start.offset);
    deleteRange.setEnd(end.node, end.offset);
    deleteRange.deleteContents();
    this.softEmptyLine = null;
    this.placeCaretAtBlockOffset(block, offset - 1);
    this.editorInput(editable, { inputType: 'deleteContentBackward' });
    this.updateCustomCaret();
    
    return true;
  }

  softEmptyLineBlock(editable) {
    if (!this.softEmptyLine?.blockId) return null;
    const block = editable.querySelector(`[data-block-id="${CSS.escape(this.softEmptyLine.blockId)}"]`);
    return block || null;
  }

  isEmptySoftLineAtOffset(block, offset) {
    const text = (block.textContent || '').replace(/\uFEFF/g, '');
    if (offset <= 0 || text[offset - 1] !== '\n') return false;
    const nextLineBreak = text.indexOf('\n', offset);
    const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
    return lineEnd === offset;
  }

  clearSoftEmptyLineIfStale(editable) {
    if (!this.softEmptyLine) return;
    const block = this.softEmptyLineBlock(editable);
    if (!block) {
      this.softEmptyLine = null;
      return;
    }
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && !range.collapsed) return;
    const caretOffset = range ? this.caretOffsetInBlock(block, range) : null;
    const text = block.textContent || '';
    const caretIsOnSoftLine = this.isCaretOnSoftEmptyLine(block, caretOffset);
    const stillEmptyLine = text[this.softEmptyLine.offset - 1] === '\n' && this.isEmptySoftLineAtOffset(block, this.softEmptyLine.offset);
    if (!stillEmptyLine || !caretIsOnSoftLine) this.softEmptyLine = null;
  }

  isCaretOnSoftEmptyLine(block, caretOffset) {
    if (!this.softEmptyLine || block?.dataset?.blockId !== this.softEmptyLine.blockId) return false;
    if (!this.isEmptySoftLineAtOffset(block, this.softEmptyLine.offset)) return false;
    return caretOffset === this.softEmptyLine.offset || caretOffset === this.softEmptyLine.offset - 1;
  }

  placeCaretAtBlockOffset(block, offset) {
    const position = this.blockTextPosition(block, offset);
    if (!position) return false;
    const range = document.createRange();
    range.setStart(position.node, Math.min(position.offset, position.node.textContent.length));
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    block.closest('.page-content')?.focus();
    return true;
  }

  removeSoftEmptyLinePlaceholders(root) {
    root.querySelectorAll?.('br[data-soft-empty-line]').forEach((node) => node.remove());
    this.removeSoftEmptyLineMarkers(root);
  }

  removeSoftEmptyLineMarkers(root) {
    root.querySelectorAll?.('[data-soft-caret]').forEach((node) => node.remove());
  }

  caretOffsetInBlock(block, range) {
    try {
      const pre = range.cloneRange();
      pre.selectNodeContents(block);
      pre.setEnd(range.startContainer, range.startOffset);
      return pre.toString().length;
    } catch {
      return null;
    }
  }

  blockTextPosition(block, targetOffset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = targetOffset;
    while (node) {
      const length = node.textContent.length;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      node = walker.nextNode();
    }
    if (block.lastChild?.nodeType === Node.TEXT_NODE) {
      return { node: block.lastChild, offset: block.lastChild.textContent.length };
    }
    return null;
  }

  normalizeEditable(editable) {
    if (!editable) return;
    let wrapper = null;
    [...editable.childNodes].forEach((node) => {
      if (this.isEditorBlockNode(node)) {
        wrapper = null;
        if (!node.dataset.blockId) node.dataset.blockId = uid('block');
        this.ensureEditableBlockContent(node);
        return;
      }

      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) {
        node.remove();
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE && node.matches('div')) {
        const block = this.createEditorBlock('paragraph');
        block.innerHTML = '';
        while (node.firstChild) block.appendChild(node.firstChild);
        this.ensureEditableBlockContent(block);
        node.replaceWith(block);
        wrapper = null;
        return;
      }

      if (!wrapper || wrapper.nextSibling !== node) {
        wrapper = this.createEditorBlock('paragraph');
        wrapper.innerHTML = '';
        editable.insertBefore(wrapper, node);
      }
      wrapper.appendChild(node);
      this.ensureEditableBlockContent(wrapper);
    });

    if (!this.editorBlocks(editable).length) {
      const block = this.createEditorBlock('paragraph');
      editable.appendChild(block);
      this.placeCaretAtStart(block);
    }
  }

  isEditorBlockNode(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.matches('p,h1,h2,h3,blockquote,[data-block-id]');
  }

  editorBlocks(editable) {
    if (!editable) return [];
    return [...editable.querySelectorAll('[data-block-id]')];
  }

  blockForSelection(editable) {
    const sel = getSelection();
    const node = sel?.anchorNode;
    const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    return element?.closest?.('[data-block-id]') || this.editorBlocks(editable)[0] || null;
  }

  selectionInsideBlock(block) {
    const node = getSelection()?.anchorNode;
    return !!node && (node === block || block.contains(node));
  }

  createEditorBlock(type = 'paragraph') {
    const tag = type === 'heading' ? 'h2' : type === 'quote' ? 'blockquote' : 'p';
    const block = document.createElement(tag);
    block.dataset.blockId = uid('block');
    block.innerHTML = '<br>';
    return block;
  }

  blockPlainText(block) {
    return cleanAnalysisResidue(block?.textContent || '').trim();
  }

  ensureEditableBlockContent(block) {
    if (cleanAnalysisResidue(block.textContent || '').length || block.querySelector('br,img')) return;
    block.innerHTML = '<br>';
  }

  placeCaretAtStart(node) {
    const sel = getSelection();
    const range = document.createRange();
    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    if (text) range.setStart(text, 0);
    else range.setStart(node, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    node.closest('.page-content')?.focus();
  }

  runAction(action, event) {
    const map = {
      'macro-record-toggle': () => {
        this.macroRecordingState = !this.macroRecordingState;
        if (this.macroRecordingState) {
          this.macroRecordedKeys = '';
          this.recordedHeldKeys = new Set();
        }
        this.renderMacrosListOnly();
      },
      'macro-save-new': () => {
        const keys = (this.macroRecordedKeys || '').trim();
        const value = (document.getElementById('new-macro-value')?.value || '').trim();
        if (!keys || !value) {
          this.toast(!keys ? 'Сначала запишите сочетание клавиш.' : 'Укажите выводимый символ.');
          return;
        }
        const conflict = this.checkMacroConflict(keys);
        if (conflict && conflict.includes('Конфликт с горячей клавишей')) {
          this.toast('Нельзя перезаписать системную клавишу Ноктюрна.');
          return;
        }
        this.state.settings.macros = this.state.settings.macros || [];
        const normalize = (str) => {
          return str.split('+')
            .map((s) => s.trim().toUpperCase())
            .map((s) => s === 'CONTROL' ? 'CTRL' : s === 'OPTION' || s === 'COMMAND' ? 'META' : s)
            .sort()
            .join('+');
        };
        const existingIdx = this.state.settings.macros.findIndex(m => normalize(m.keys) === normalize(keys));
        if (existingIdx !== -1) {
          this.state.settings.macros[existingIdx].value = value;
        } else {
          this.state.settings.macros.push({ keys, value });
        }
        this.macroRecordedKeys = '';
        this.macroRecordingState = false;
        this.persistSettings();
        this.renderMacrosListOnly();
        this.toast(existingIdx !== -1 ? 'Макрос обновлен.' : 'Макрос успешно добавлен.');
      },
      'macro-delete': () => {
        const btn = event.target.closest('[data-macro-idx]');
        const idx = parseInt(btn?.dataset.macroIdx, 10);
        if (Number.isFinite(idx) && this.state.settings.macros) {
          this.state.settings.macros.splice(idx, 1);
          this.persistSettings();
          this.renderMacrosListOnly();
          this.toast('Макрос удален.');
        }
      },
      'open-settings': () => { this.closeAllFloatingMenus(); document.getElementById('settings-overlay').classList.add('active'); },
      'open-command-palette': () => this.commandPalette.open(),
            'close-command-palette': () => this.commandPalette.close(),
      'close-settings': () => document.getElementById('settings-overlay').classList.remove('active'),
      'toggle-kb-menu': () => {
        const willOpen = !this.isFloatingMenuOpen('kb');
        if (willOpen) this.openFloatingMenu('kb');
        else this.closeFloatingMenu('kb');
      },
      'toggle-split': () => this.toggleSplitMenu(),
      'toggle-format-menu': () => {
        const willOpen = !this.isFloatingMenuOpen('format');
        if (willOpen) this.openFloatingMenu('format');
        else this.closeFloatingMenu('format');
      },
      'toggle-search-menu': () => {
        const willOpen = !this.isFloatingMenuOpen('search');
        if (willOpen) this.openFloatingMenu('search');
        else this.closeFloatingMenu('search');
      },
      'open-search-chooser': () => { this.closeFloatingMenu('search'); this.openSearchChooser(); },
      'open-replace-window': () => { this.closeFloatingMenu('search'); this.openReplaceWindow(); },
      'search-mode-current': () => { document.getElementById('form-overlay').classList.remove('active'); this.openDocumentSearch(); },
      'search-mode-global': () => { document.getElementById('form-overlay').classList.remove('active'); this.openGlobalSearchWindow(); },
      'close-doc-search': () => this.closeDocumentSearch(),
      'search-prev': () => this.moveSearchResult(-1),
      'search-next': () => this.moveSearchResult(1),
      'replace-find-next': () => this.replaceFindNext(),
      'replace-current': () => this.replaceCurrentMatch(),
      'replace-all-preview': () => this.showReplaceAllPreview(),
      'confirm-replace-all': () => this.confirmReplaceAll(),
      'open-search-result': () => this.openSearchResult(event.target.closest('[data-doc-id]')?.dataset),
      'open-entity-mentions': () => {
        const target = event.target.closest('[data-entity-kind][data-entity-id]');
        if (target) this.openEntityMentions(target.dataset.entityKind, target.dataset.entityId);
      },
      'import-doc': () => document.getElementById('import-input').click(),
      'toggle-ai': () => this.togglePanel('ai-panel'),
      'toggle-notes': () => this.togglePanel('notes-panel'),
      'open-shortcuts': () => this.openShortcutsModal(),
      'close-shortcuts': () => this.closeShortcutsModal(),
      'close-ai': () => document.getElementById('ai-panel').classList.remove('open'),
      'close-notes': () => document.getElementById('notes-panel').classList.remove('open'),
      'apply-ai-preset': () => this.applyAiPreset(event.target.closest('[data-ai-preset]')?.dataset.aiPreset),
      'test-ai-connection': () => this.testAiConnection(),
      'close-kb': () => {
        this.state.activeSubtimelineId = null;
        this.state.activeLoreDetail = null;
        document.getElementById('kb-modal').classList.remove('active');
      },
      'toggle-zen': () => this.toggleZen(),
      'new-doc': () => this.openDocForm(event.target.closest('[data-folder-id]')?.dataset.folderId || this.defaultFolderId()),
      'delete-doc': () => this.confirmDeleteDoc(event.target.closest('[data-doc-id]')?.dataset.docId || this.state.activeDocId),
      'new-lore': () => this.editLore(event.target.closest('[data-lore-type]')?.dataset.loreType),
      'accept-ai': () => this.acceptSuggestion(),
      'reject-ai': () => this.rejectSuggestion(),
      'clean-note': () => {
        const id = event.target.closest('[data-lore-id]')?.dataset.loreId;
        if (id) this.openCleanerModal(id);
      },
      'clean-all-notes': () => {
        this.openCleanerModal();
      },
      'close-cleaner': () => {
        document.getElementById('cleaner-overlay')?.classList.remove('active');
      },
      'manual-snapshot': () => this.createSnapshot(true),
      'export-html': () => this.exportPrintable(),
      'export-docx': () => this.exportDocx(),
      'export-project-dump': () => this.openProjectExportModal(),
      'confirm-export-project-dump': async () => {
        document.getElementById('form-overlay')?.classList.remove('active');
        await this.exportProjectDump();
      },
      'import-project-dump': () => this.startProjectDumpImport(),
      'confirm-export-project-dump-plaintext': async () => {
        const ok = await this.confirmDialog({
          title: 'Экспортировать E2E-данные открытым текстом?',
          message: 'Plaintext-экспорт может включать расшифрованные документы, заметки и снапшоты. Используйте его только для доверенного места хранения.',
          confirmText: 'Экспорт plaintext',
          icon: 'bx-lock-open',
        });
        if (ok) await this.exportProjectDump({ plaintextE2e: true });
      },
      'preview-ai-context': () => this.openAiContextPreview(),
      'show-history': () => this.showHistory(),
      'save-password': () => this.setSessionPassword(),
      'reset-data': () => this.resetData(),
      'clear-all-docs': async () => {
        const ok = await this.confirmDialog({
          title: 'Удалить все документы?',
          message: 'Все ваши папки, документы, снапшоты и история версий будут безвозвратно удалены. Рекомендуется сначала сделать экспорт проекта (.nocturnedump).',
          confirmText: 'Удалить все',
          icon: 'bx-trash',
          danger: true,
        });
        if (ok) {
          await this.db.clear('docs');
          await this.db.clear('folders');
          await this.db.clear('snapshots');
          safeStorageKeys(localStorage).forEach((key) => {
            if (key.startsWith(LIVE_PREFIX)) safeRemoveStorageItem(localStorage, key);
          });
          this.state.folders = this.validateFolders([]);
          this.state.docs = [];
          this.state.activeDocId = null;
          await Promise.all(this.state.folders.map((item) => this.db.put('folders', item)));
          this.initWorkspace();
          this.renderAll();
          this.renderSettings();
          this.toast('Все документы и папки удалены.');
        }
      },
      'clear-all-characters': async () => {
        const ok = await this.confirmDialog({
          title: 'Удалить всех персонажей?',
          message: 'Все персонажи будут навсегда удалены из Базы Знаний.',
          confirmText: 'Удалить',
          icon: 'bx-user-x',
          danger: true,
        });
        if (ok) {
          this.state.lore.characters = [];
          await this.saveLore();
          this.renderAll();
          this.renderSettings();
          this.toast('Все персонажи удалены.');
        }
      },
      'clear-all-locations': async () => {
        const ok = await this.confirmDialog({
          title: 'Удалить все локации?',
          message: 'Все локации и места будут навсегда удалены из Базы Знаний.',
          confirmText: 'Удалить',
          icon: 'bx-map-x',
          danger: true,
        });
        if (ok) {
          this.state.lore.locations = [];
          await this.saveLore();
          this.renderAll();
          this.renderSettings();
          this.toast('Все локации удалены.');
        }
      },
      'clear-all-timeline': async () => {
        const ok = await this.confirmDialog({
          title: 'Удалить все события?',
          message: 'Все события хронологии и сабтаймлайны будут навсегда удалены.',
          confirmText: 'Удалить',
          icon: 'bx-git-commit',
          danger: true,
        });
        if (ok) {
          this.state.lore.timeline = [];
          this.state.activeSubtimelineId = null;
          await this.saveLore();
          this.renderAll();
          this.renderSettings();
          this.toast('Хронология очищена.');
        }
      },
      'clear-all-notes': async () => {
        const ok = await this.confirmDialog({
          title: 'Удалить все записи?',
          message: 'Все записи и заметки будут навсегда удалены из Базы Знаний.',
          confirmText: 'Удалить',
          icon: 'bx-note',
          danger: true,
        });
        if (ok) {
          this.state.lore.notes = [];
          await this.saveLore();
          this.renderAll();
          this.renderSettings();
          this.toast('Все записи удалены.');
        }
      },
      'clear-all-kb': async () => {
        const ok = await this.confirmDialog({
          title: 'Очистить всю Базу Знаний?',
          message: 'Все персонажи, локации, события таймлайна и записи будут навсегда удалены.',
          confirmText: 'Очистить базу',
          icon: 'bx-book-content',
          danger: true,
        });
        if (ok) {
          this.state.lore.characters = [];
          this.state.lore.locations = [];
          this.state.lore.timeline = [];
          this.state.lore.notes = [];
          this.state.activeSubtimelineId = null;
          await this.saveLore();
          this.renderAll();
          this.renderSettings();
          this.toast('База Знаний полностью очищена.');
        }
      },
      'reset-settings': () => this.resetSettings(),
      'demo-add-docs': () => this.addDemoDocs(),
      'demo-remove-docs': () => this.removeDemoDocs(),
      'set-accent-preset': () => this.setAccentColor(event.target.closest('[data-accent-value]')?.dataset.accentValue),
      'reset-accent': () => this.setAccentColor(defaultSettings.accent),
      'demo-add-lore': () => this.addDemoLore(),
      'demo-remove-lore': () => this.removeDemoLore(),
      'demo-add-timeline': () => this.addDemoTimeline(),
      'demo-remove-timeline': () => this.removeDemoTimeline(),
      'demo-add-all': () => this.addFullDemoSet(),
      'demo-remove-all': () => this.removeFullDemoSet(),
      'clear-temp-notes': () => this.clearTemporaryNotes(),
      'clear-current-review-marks': () => this.clearCurrentDocumentReviewMarks(),
      'reset-hidden-floating-notes': () => this.resetHiddenFloatingNotes(),
      'note-divider': () => this.insertNoteSnippet('\n\n---\n\n'),
      'note-checklist': () => this.insertNoteSnippet('\n- [ ] '),
      'note-toggle-check': () => this.toggleNoteChecklist(),
      'note-heading': () => this.insertNoteSnippet('\n\n## '),
    };
    map[action]?.();
    const notesMode = event.target.closest('[data-notes-mode]')?.dataset.notesMode;
    if (notesMode) {
      this.state.noteMode = notesMode;
      this.renderNotes();
    }
  }

  togglePanel(id) {
    const panel = document.getElementById(id);
    document.querySelectorAll('.side-panel').forEach((el) => {
      if (el !== panel) el.classList.remove('open');
    });
    panel.classList.toggle('open');
    if (id === 'ai-panel') this.updateAssistantPanelState();
  }

  async toggleZen(force = null, options = {}) {
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    const enabled = force ?? !this.state.zenActive;
    this.state.zenActive = !!enabled;
    shell.classList.toggle('zen', this.state.zenActive);
    document.body.classList.toggle('zen-mode', this.state.zenActive);
    document.querySelectorAll('[data-action="toggle-zen"]').forEach((button) => {
      button.classList.toggle('active', this.state.zenActive);
      button.setAttribute('aria-pressed', this.state.zenActive ? 'true' : 'false');
      button.title = this.state.zenActive ? 'Выйти из режима Дзен' : 'Режим Дзен';
    });
    if (this.state.zenActive) {
      this.closeAllFloatingMenus();
      document.querySelectorAll('.side-panel.open').forEach((panel) => panel.classList.remove('open'));
    }
    if (options.persist) await this.persistSettings();
  }

  renderDocs() {
    this.cleanupSortableDragState();
    const container = document.getElementById('docs-container');
    this.closeDocContextMenu();
    const q = this.state.docSearch.toLowerCase().trim();
    const isFocused = document.activeElement?.id === 'doc-search';
    
    container.innerHTML = `
      <div class="doc-search-wrap">
        <div class="doc-search-field">
          <i class="bx bx-search"></i>
          <input class="doc-search" id="doc-search" placeholder="Поиск документов..." value="${escapeHtml(this.state.docSearch)}">
        </div>
        <button class="btn-icon folder-add-btn" data-action="new-folder" title="Создать папку"><i class="bx bx-folder-plus"></i></button>
      </div>
      <div class="docs-list-scroll">

      ${this.state.folders.map((folder) => {
      const collapsed = this.state.collapsedFolders.includes(folder.id);
      let docs = this.state.docs
        .filter((doc) => doc.folderId === folder.id)
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.order - b.order);
      if (q) {
        const byTitle = docs.filter((d) => d.title.toLowerCase().includes(q));
        const byDesc = docs.filter((d) => !byTitle.includes(d) && (d.description || d.summary || '').toLowerCase().includes(q));
        const byMeta = docs.filter((d) => !byTitle.includes(d) && !byDesc.includes(d) && d.docType === 'book-chapter' && (
          (d.workTitle || '').toLowerCase().includes(q) ||
          (d.volume || '').toLowerCase().includes(q) ||
          (d.chapterNumber || '').toLowerCase().includes(q) ||
          (d.bookStatus || '').toLowerCase().includes(q)
        ));
        docs = [...byTitle, ...byDesc, ...byMeta];
      }
      return `
        <div class="section-title" data-folder-id="${folder.id}">
          <div class="section-title-left" data-action="toggle-folder" data-folder="${folder.id}">
            <i class="bx bx-chevron-${collapsed ? 'right' : 'down'} folder-chevron"></i>
            <span>${escapeHtml(folder.title)}</span>
          </div>
          <div class="folder-actions">
            <button class="btn-icon" data-action="new-doc" data-folder-id="${escapeHtml(folder.id)}" title="Новый документ"><i class="bx bx-plus"></i></button>
            <button class="btn-icon" data-action="rename-folder" data-folder-id="${escapeHtml(folder.id)}" title="Переименовать папку"><i class="bx bx-edit-alt"></i></button>
            <button class="btn-icon" data-action="delete-folder" data-folder-id="${escapeHtml(folder.id)}" title="Удалить папку"><i class="bx bx-trash"></i></button>
          </div>
        </div>
        <div class="folder-docs ${collapsed ? 'collapsed' : ''}">
        ${docs.length ? docs.map((doc) => {
          const isBook = doc.docType === 'book-chapter';
          const isNew = this.state.newlyCreatedId === doc.id;
          const entranceClass = isNew ? ' new-doc-entrance' : '';
          return `
          <div class="doc-item ${isBook ? 'book-chapter-card' : ''} ${doc.id === this.state.activeDocId ? 'active' : ''} ${doc.pinned ? 'pinned' : ''}${entranceClass}" data-doc-id="${doc.id}">
            ${isBook ? `
            <div class="book-chapter-header">
              <span class="book-work-info"><i class="bx bx-library"></i> <span>${escapeHtml(doc.workTitle || 'Книга')}${doc.volume ? ` · ${escapeHtml(doc.volume)}` : ''}</span></span>
            </div>
            ` : ''}
            <div class="doc-title"><i class="bx ${isBook ? 'bx-book-open' : (doc.pinned ? 'bx-pin' : (doc.locked ? 'bx-lock' : 'bx-file'))}"></i> <span>${isBook && doc.chapterNumber ? `<span class="chapter-number">${escapeHtml(doc.chapterNumber)}</span>: ` : ''}${escapeHtml(doc.title)}</span></div>
            <button class="doc-menu-btn" data-doc-menu="${doc.id}" title="Меню"><i class="bx bx-dots-vertical-rounded"></i></button>
            <div class="doc-desc">${escapeHtml(doc.description || doc.summary || 'Без описания')}</div>
            ${isBook ? `
            <div class="book-card-footer">
              <span class="book-status-inline status-${this.statusSlug(doc.bookStatus)}">
                <span class="status-dot"></span>
                <span class="status-name">${escapeHtml(this.statusShortName(doc.bookStatus))}</span>
              </span>
            </div>
            ` : ''}
          </div>
        `}).join('') : this.folderEmptyState(folder.id, q)}
        </div>
      `;
    }).join('')}
      </div>`;
    
    this.setupDocSortables();
    const searchInput = document.getElementById('doc-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.state.docSearch = e.target.value;
        this.renderDocs();
      });
      if (isFocused) {
        setTimeout(() => {
          searchInput.focus();
          searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
        }, 0);
      }
    }

    if (this.state.newlyCreatedId) {
      const targetId = this.state.newlyCreatedId;
      setTimeout(() => {
        if (this.state.newlyCreatedId === targetId) {
          document.querySelectorAll('.new-doc-entrance, .new-card-entrance').forEach(el => {
            el.classList.remove('new-doc-entrance', 'new-card-entrance');
          });
          this.state.newlyCreatedId = null;
        }
      }, 1000);
    }
  }

  folderEmptyState(folderId, isSearch = false) {
    return `<div class="doc-folder-empty">
      <i class="bx bx-file-blank"></i>
      <span>${isSearch ? 'В этой папке нет совпадений.' : 'В этой папке пока нет документов.'}</span>
      ${isSearch ? '' : `<button class="mini-text-btn" data-action="new-doc" data-folder-id="${escapeHtml(folderId)}">Создать документ</button>`}
    </div>`;
  }

  defaultFolderId() {
    return this.state.folders.find((folder) => folder.id === 'manuscript')?.id || this.state.folders[0]?.id || 'manuscript';
  }

  statusSlug(status) {
    const map = {
      'Не редактировано': 'unread',
      'На редакции': 'editing',
      'Вычитка': 'proofreading',
      'Чистовая версия': 'clean',
      'Закончено': 'done'
    };
    return map[status] || 'unread';
  }

  statusShortName(status) {
    const map = {
      'Не редактировано': 'Не-ред.',
      'На редакции': 'Редакт.',
      'Вычитка': 'Вычитка',
      'Чистовая версия': 'Чистовик',
      'Закончено': 'Готово'
    };
    return map[status] || status || 'Не-ред.';
  }

  normalizeFolderOrders() {
    this.state.folders.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    this.state.folders.forEach((folder, order) => { folder.order = order; });
  }

  validateForm(form) {
    let isValid = true;
    const inputs = form.querySelectorAll('[required]');
    inputs.forEach(input => {
      const val = input.value.trim();
      if (!val) {
        isValid = false;
        input.classList.add('invalid');
        if (!input.dataset.hasValidationListener) {
          input.dataset.hasValidationListener = 'true';
          const clearInvalid = () => {
            if (input.value.trim()) {
              input.classList.remove('invalid');
              input.removeEventListener('input', clearInvalid);
              input.removeEventListener('change', clearInvalid);
              delete input.dataset.hasValidationListener;
            }
          };
          input.addEventListener('input', clearInvalid);
          input.addEventListener('change', clearInvalid);
        }
      } else {
        input.classList.remove('invalid');
      }
    });
    if (!isValid) {
      const firstInvalid = form.querySelector('.invalid');
      if (firstInvalid) {
        firstInvalid.focus();
        firstInvalid.select?.();
        firstInvalid.classList.add('shake');
        setTimeout(() => firstInvalid.classList.remove('shake'), 400);
      }
    }
    return isValid;
  }

  animateLayoutTransition(container, mutateDOM) {
    if (!container) {
      mutateDOM();
      return;
    }
    
    // 1. Record current positions of all children
    const children = Array.from(container.children);
    const oldRects = children.map(child => ({
      element: child,
      rect: child.getBoundingClientRect()
    }));

    // 2. Perform DOM mutation
    mutateDOM();

    // 3. Immediately measure new positions synchronously (before painting)
    const newRects = oldRects.map(item => {
      if (!item.element.parentNode) return null;
      const newRect = item.element.getBoundingClientRect();
      const dx = item.rect.left - newRect.left;
      const dy = item.rect.top - newRect.top;
      return {
        element: item.element,
        dx,
        dy
      };
    }).filter(Boolean);

    // 4. Immediately invert synchronously to keep layout position visually unchanged
    newRects.forEach(item => {
      if (item.dx === 0 && item.dy === 0) return;
      item.element.style.transition = 'none';
      item.element.style.transform = `translate(${item.dx}px, ${item.dy}px)`;
    });

    // 5. Play (transition to 0,0)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newRects.forEach(item => {
          if (item.dx === 0 && item.dy === 0) return;
          item.element.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
          item.element.style.transform = 'translate(0, 0)';
          
          setTimeout(() => {
            item.element.style.transition = '';
            item.element.style.transform = '';
          }, 450);
        });
      });
    });
  }

  animateShatter(element, callback) {
    if (!element) {
      if (callback) callback();
      return;
    }
    
    // 1. Start html2canvas capture immediately on the pristine element (before adding red shake borders)
    const capturePromise = window.html2canvas ? 
      window.html2canvas(element, {
        backgroundColor: null,
        logging: false,
        useCORS: true,
        scale: window.devicePixelRatio || 1
      }).catch(err => {
        console.warn('html2canvas failed:', err);
        return null;
      }) : Promise.resolve(null);

    // 2. Add the GPU-accelerated shake animation on the next frame
    requestAnimationFrame(() => {
      element.classList.add('delete-shake');
    });

    const shakePromise = new Promise(resolve => setTimeout(resolve, 280));

    Promise.all([capturePromise, shakePromise]).then(([canvas]) => {
      element.classList.remove('delete-shake');
      
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        callback();
        return;
      }

      // Hide the element instantly so it appears to dissolve into dust
      element.style.visibility = 'hidden';
      element.style.pointerEvents = 'none';

      // Create a fullscreen overlay canvas to prevent particles from clipping
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = window.innerWidth;
      overlayCanvas.height = window.innerHeight;
      overlayCanvas.style.position = 'fixed';
      overlayCanvas.style.left = '0px';
      overlayCanvas.style.top = '0px';
      overlayCanvas.style.zIndex = '999999';
      overlayCanvas.style.pointerEvents = 'none';
      document.body.appendChild(overlayCanvas);

      const ctx = overlayCanvas.getContext('2d');
      if (!ctx) {
        overlayCanvas.remove();
        callback();
        return;
      }

      const w = rect.width;
      const h = rect.height;
      const particles = [];

      if (canvas) {
        // Draw captured element to a temporary offscreen canvas to sample pixel colors
        const offscreen = document.createElement('canvas');
        offscreen.width = canvas.width;
        offscreen.height = canvas.height;
        const offCtx = offscreen.getContext('2d');
        if (offCtx) {
          offCtx.drawImage(canvas, 0, 0);
          const imgData = offCtx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;
          const canvasW = canvas.width;
          const canvasH = canvas.height;
          const scaleX = canvasW / w;
          const scaleY = canvasH / h;

          const elemCenterX = w / 2;
          const elemCenterY = h / 2;

          // Sample pixels at regular intervals to create a beautiful cloud of tiny circular particles (Xiaomi style)
          const step = 5; // Sample every 5px
          for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
              const cx = Math.floor(x * scaleX);
              const cy = Math.floor(y * scaleY);
              if (cx >= canvasW || cy >= canvasH) continue;

              const idx = (cy * canvasW + cx) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              const a = data[idx + 3];

              // Skip completely transparent pixels
              if (a < 35) continue;

              const color = `rgba(${r},${g},${b},${a / 255})`;
              
              // Radial direction from center of the card
              const dirX = x - elemCenterX;
              const dirY = y - elemCenterY;
              const dist = Math.sqrt(dirX * dirX + dirY * dirY) || 1;

              // Xiaomi style radial expansion: outer particles blast faster, with upward lift
              const radialSpeed = (dist / Math.max(w, h)) * 4.5 + Math.random() * 2.5 + 0.8;
              const vx = (dirX / dist) * radialSpeed + (Math.random() - 0.5) * 1.5;
              const vy = (dirY / dist) * radialSpeed - 2.5 - Math.random() * 3.5;

              particles.push({
                x: rect.left + x,
                y: rect.top + y,
                vx,
                vy,
                color,
                size: Math.random() * 1.6 + 1.2, // Tiny circular particles
                alpha: 1,
                decay: 0.012 + Math.random() * 0.016,
                gravity: 0.16 + Math.random() * 0.1
              });
            }
          }
        }
      }

      // If html2canvas failed or yielded no particles, populate beautiful accent-colored particles
      if (particles.length === 0) {
        const accent = window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';
        const numFallback = 150;
        for (let i = 0; i < numFallback; i++) {
          const rx = Math.random() * w;
          const ry = Math.random() * h;
          const dirX = rx - w / 2;
          const dirY = ry - h / 2;
          const dist = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
          const vx = (dirX / dist) * (Math.random() * 3 + 1.5);
          const vy = (dirY / dist) * (Math.random() * 2) - 2 - Math.random() * 3;
          particles.push({
            x: rect.left + rx,
            y: rect.top + ry,
            vx,
            vy,
            color: accent,
            size: Math.random() * 2 + 1.5,
            alpha: 1,
            decay: 0.015 + Math.random() * 0.015,
            gravity: 0.2
          });
        }
      }

      let animationFrameId;
      const animate = () => {
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        let activeParticles = 0;

        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          if (p.alpha <= 0) continue;
          activeParticles++;

          p.x += p.vx;
          p.y += p.vy;
          p.vy += p.gravity;
          p.alpha -= p.decay;

          if (p.alpha > 0) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fillStyle = p.color;
            ctx.globalAlpha = p.alpha;
            ctx.fill();
          }
        }

        if (activeParticles > 0) {
          animationFrameId = requestAnimationFrame(animate);
        } else {
          cancelAnimationFrame(animationFrameId);
          overlayCanvas.remove();
          callback();
        }
      };

      animate();
    });
  }

  openFolderForm(folderId = null) {
    const folder = folderId ? this.state.folders.find((item) => item.id === folderId) : null;
    if (folderId && !folder) return;
    this.closeAllFloatingMenus();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <form class="form-modal folder-form" id="folder-form" novalidate>
        <h2>${folder ? 'Переименовать папку' : 'Новая папка'}</h2>
        <div class="form-grid">
          <label>Название <input class="form-control" name="title" maxlength="80" value="${escapeHtml(folder?.title || '')}" required></label>
        </div>
        <div class="form-actions">
          <button class="pill-btn" type="button" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" type="submit">${folder ? 'Сохранить' : 'Создать'}</button>
        </div>
      </form>
    `;
    overlay.classList.add('active');
    const input = overlay.querySelector('[name="title"]');
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      if (!this.validateForm(event.target)) return;
      const title = String(new FormData(event.target).get('title') || '').trim().replace(/\s+/g, ' ');
      if (!title) {
        return;
      }
      overlay.classList.remove('active');
      setTimeout(async () => {
        if (folder) {
          folder.title = title.slice(0, 80);
          folder.updatedAt = Date.now();
          await this.db.put('folders', folder);
          this.toast('Папка переименована.');
        } else {
          const now = Date.now();
          const next = {
            id: uid('folder'),
            title: title.slice(0, 80),
            order: this.state.folders.length,
            createdAt: now,
            updatedAt: now,
          };
          this.state.folders.push(next);
          this.state.collapsedFolders = this.state.collapsedFolders.filter((id) => id !== next.id);
          safeSetStorageItem(localStorage, 'nocturne-collapsed-folders', JSON.stringify(this.state.collapsedFolders));
          await this.db.put('folders', next);
          this.toast('Папка создана.');
        }
        this.normalizeFolderOrders();
        this.renderDocs();
      }, 100);
    };
  }

  confirmDeleteFolder(folderId) {
    const folder = this.state.folders.find((item) => item.id === folderId);
    if (!folder) return;
    if (this.state.folders.length <= 1) {
      this.toast('Нужна хотя бы одна папка для документов.');
      return;
    }
    const docsInside = this.state.docs.filter((doc) => doc.folderId === folderId);
    if (docsInside.length) {
      this.toast('В папке есть документы. Сначала перенесите их в другую папку или удалите.');
      return;
    }
    this.closeAllFloatingMenus();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-folder-minus"></i></div>
        <h2>Удалить папку?</h2>
        <p>«${escapeHtml(folder.title)}» будет удалена. Документов в ней нет.</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn danger-btn" data-confirm-folder-delete="${escapeHtml(folder.id)}">Удалить</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-confirm-folder-delete]').onclick = async () => {
      overlay.classList.remove('active');
      const folderEl = document.querySelector(`.section-title[data-folder-id="${folder.id}"]`);
      const folderDocsEl = document.querySelector(`.section-title[data-folder-id="${folder.id}"] + .folder-docs`);
      this.animateShatter(folderEl, async () => {
        if (folderEl) {
          const parentGrid = folderEl.parentElement;
          this.animateLayoutTransition(parentGrid, () => {
            folderEl.remove();
            if (folderDocsEl) folderDocsEl.remove();
          });
        }
        await this.deleteFolder(folder.id, true);
      });
    };
  }

  async deleteFolder(folderId, localOnly = false) {
    const folder = this.state.folders.find((item) => item.id === folderId);
    if (!folder) return;
    if (this.state.folders.length <= 1) {
      this.toast('Нужна хотя бы одна папка для документов.');
      return;
    }
    if (this.state.docs.some((doc) => doc.folderId === folderId)) {
      this.toast('В папке есть документы. Сначала перенесите их в другую папку или удалите.');
      return;
    }
    this.state.folders = this.state.folders.filter((item) => item.id !== folderId);
    this.normalizeFolderOrders();
    this.state.collapsedFolders = this.state.collapsedFolders.filter((id) => id !== folderId);
    safeSetStorageItem(localStorage, 'nocturne-collapsed-folders', JSON.stringify(this.state.collapsedFolders));
    await this.db.delete('folders', folderId);
    await Promise.all(this.state.folders.map((item) => this.db.put('folders', item)));
    if (!localOnly) {
      this.renderDocs();
    }
    this.toast('Папка удалена.');
  }

  openDocForm(folderId) {
    const targetFolderId = this.state.folders.some((folder) => folder.id === folderId) ? folderId : this.defaultFolderId();
    this.closeAllFloatingMenus();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <form class="form-modal doc-form" id="doc-form" novalidate>
        <h2>Новый документ</h2>
        
        <div class="doc-type-switcher">
          <label class="doc-type-radio"><input type="radio" name="docType" value="document" checked> <span><i class="bx bx-file"></i> Обычный документ</span></label>
          <label class="doc-type-radio"><input type="radio" name="docType" value="book-chapter"> <span><i class="bx bx-book-open"></i> Глава книги</span></label>
        </div>

        <div class="form-grid">
          <label><span class="doc-title-label">Название</span> <input class="form-control" name="title" value="Новый документ" required></label>
          <label>Описание документа <textarea class="form-control" name="description" placeholder="Кратко: что происходит в этой главе, зачем она нужна, какой тон сцены."></textarea></label>
        </div>

        <div class="book-chapter-fields-wrapper">
          <div class="form-grid book-chapter-fields">
            <label>Произведение <input class="form-control" name="workTitle" placeholder="Название произведения"></label>
            <label>Том <input class="form-control" name="volume" placeholder="Например: Том 1"></label>
            <label>Глава <input class="form-control" name="chapterNumber" placeholder="Например: 1 или Глава 1"></label>
            <label>Статус
              <div class="nocturne-select" id="book-status-select" style="width: 100%;">
                <input type="hidden" name="bookStatus" value="Не редактировано">
                <button type="button" class="nocturne-select-trigger" data-setting-select-toggle style="width: 100%;">
                  <span>Не редактировано</span>
                  <i class="bx bx-chevron-down"></i>
                </button>
                <div class="nocturne-select-menu popover-surface" role="listbox" aria-hidden="true" style="width: 100%; min-width: 100%;">
                  <button type="button" class="nocturne-select-option selected" role="option" data-book-status-option data-value="Не редактировано">
                    <span>Не редактировано</span>
                    <i class="bx bx-check"></i>
                  </button>
                  <button type="button" class="nocturne-select-option" role="option" data-book-status-option data-value="На редакции">
                    <span>На редакции</span>
                    <i class="bx bx-check"></i>
                  </button>
                  <button type="button" class="nocturne-select-option" role="option" data-book-status-option data-value="Вычитка">
                    <span>Вычитка</span>
                    <i class="bx bx-check"></i>
                  </button>
                  <button type="button" class="nocturne-select-option" role="option" data-book-status-option data-value="Чистовая версия">
                    <span>Чистовая версия</span>
                    <i class="bx bx-check"></i>
                  </button>
                  <button type="button" class="nocturne-select-option" role="option" data-book-status-option data-value="Закончено">
                    <span>Закончено</span>
                    <i class="bx bx-check"></i>
                  </button>
                </div>
              </div>
            </label>
          </div>
        </div>

        <div class="form-actions">
          <button class="pill-btn" type="button" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" type="submit"><i class="bx bx-plus"></i> Создать</button>
        </div>
      </form>
    `;
    overlay.classList.add('active');
    
    const typeRadios = overlay.querySelectorAll('input[name="docType"]');
    const bookFieldsWrapper = overlay.querySelector('.book-chapter-fields-wrapper');
    typeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const titleLabel = overlay.querySelector('.doc-title-label');
        const titleInput = overlay.querySelector('input[name="title"]');
        if (radio.value === 'book-chapter') {
          bookFieldsWrapper.classList.add('open');
          if (titleLabel) titleLabel.textContent = 'Название главы';
          if (titleInput && titleInput.value === 'Новый документ') {
            titleInput.value = 'Новая глава';
          }
        } else {
          bookFieldsWrapper.classList.remove('open');
          if (titleLabel) titleLabel.textContent = 'Название';
          if (titleInput && titleInput.value === 'Новая глава') {
            titleInput.value = 'Новый документ';
          }
        }
      });
    });

    const setupCustomStatusSelect = (formEl) => {
      const selectEl = formEl.querySelector('#book-status-select');
      if (!selectEl) return;
      const trigger = selectEl.querySelector('[data-setting-select-toggle]');
      const hiddenInput = selectEl.querySelector('input[name="bookStatus"]');
      const options = selectEl.querySelectorAll('[data-book-status-option]');
      
      options.forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          hiddenInput.value = val;
          trigger.querySelector('span').textContent = val;
          options.forEach(o => o.classList.toggle('selected', o === opt));
          this.closeSettingsSelects();
        });
      });
    };
    setupCustomStatusSelect(overlay);

    overlay.querySelector('[name="imageFile"]')?.addEventListener('change', (event) => {
      const nameEl = overlay.querySelector('[data-file-name]');
      if (nameEl) nameEl.textContent = event.target.files?.[0]?.name || 'Файл не выбран';
    });
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      if (!this.validateForm(event.target)) return;
      const data = Object.fromEntries(new FormData(event.target));
      const descField = event.target.elements.description;
      if (!data.description?.trim()) {
        descField?.classList.add('invalid');
        descField?.classList.add('shake');
        setTimeout(() => descField?.classList.remove('shake'), 400);
        let errEl = event.target.querySelector('.field-error-msg');
        if (!errEl) {
          errEl = document.createElement('div');
          errEl.className = 'field-error-msg';
          errEl.textContent = 'Опишите кратко содержание главы — это помогает AI лучше понять контекст.';
          descField?.after(errEl);
        }
        descField?.addEventListener('input', function clearDescErr() {
          if (descField.value.trim()) {
            descField.classList.remove('invalid');
            event.target.querySelector('.field-error-msg')?.remove();
            descField.removeEventListener('input', clearDescErr);
          }
        });
        descField?.focus();
        return;
      }
      overlay.classList.remove('active');
      setTimeout(async () => {
        await this.createDoc(targetFolderId, data);
      }, 100);
    };
  }

  async createDoc(folderId, payload, legacyDescription = '') {
    let title = '';
    let description = '';
    let docType = 'document';
    let workTitle = '';
    let volume = '';
    let chapterNumber = '';
    let bookStatus = 'Не редактировано';

    if (typeof payload === 'string') {
      title = payload.trim();
      description = legacyDescription.trim();
    } else if (payload && typeof payload === 'object') {
      title = (payload.title || '').trim();
      description = (payload.description || '').trim();
      docType = payload.docType || 'document';
      workTitle = payload.workTitle?.trim() || '';
      volume = payload.volume?.trim() || '';
      chapterNumber = payload.chapterNumber?.trim() || '';
      bookStatus = payload.bookStatus || 'Не редактировано';
    }

    if (!title) return;
    if (!this.state.folders.some((folder) => folder.id === folderId)) folderId = this.defaultFolderId();
    const order = this.state.docs.filter((doc) => doc.folderId === folderId).length;
    
    let doc = {
      id: uid('doc'),
      folderId,
      title,
      description,
      order,
      notes: '',
      summary: description || 'Пустая глава.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ast: { type: 'doc', blocks: [{ id: uid('block'), type: 'heading', html: escapeHtml(title) }, { id: uid('block'), type: 'paragraph', html: '<br>' }] },
      docType
    };

    if (doc.docType === 'book-chapter') {
      doc.workTitle = workTitle;
      doc.volume = volume;
      doc.chapterNumber = chapterNumber;
      doc.bookStatus = bookStatus;
    }

    doc = this.sanitizeDoc(doc);
    this.state.docs.push(doc);
    this.docWordBaselines.set(doc.id, countWords(docText(doc.ast)));
    this.state.activeDocId = doc.id;
    this.state.workspace.panes.primary = { id: 'primary', type: 'document', docId: doc.id, entityType: null, entityId: null, kbTab: null };
    this.state.workspace.focusedPaneId = 'primary';
    if (this.isMobileLayout()) {
      this.state.mobile.activeTab = 'write';
      this.state.mobile.panel = null;
      this.state.mobile.panelMode = null;
    }
    this.persistWorkspaceState();
    await this.db.put('docs', doc);
    this.state.newlyCreatedId = doc.id;

    const folderDocsEl = document.querySelector(`.section-title[data-folder-id="${folderId}"] + .folder-docs`);
    if (folderDocsEl && !this.isMobileLayout()) {
      const emptyState = folderDocsEl.querySelector('.doc-folder-empty');
      if (emptyState) emptyState.remove();

      const isBook = doc.docType === 'book-chapter';
      const docHtml = `
      <div class="doc-item ${isBook ? 'book-chapter-card' : ''} active new-doc-entrance" data-doc-id="${doc.id}">
        ${isBook ? `
        <div class="book-chapter-header">
          <span class="book-work-info"><i class="bx bx-library"></i> <span>${escapeHtml(doc.workTitle || 'Книга')}${doc.volume ? ` · ${escapeHtml(doc.volume)}` : ''}</span></span>
        </div>
        ` : ''}
        <div class="doc-title"><i class="bx ${isBook ? 'bx-book-open' : (doc.pinned ? 'bx-pin' : (doc.locked ? 'bx-lock' : 'bx-file'))}"></i> <span>${isBook && doc.chapterNumber ? `<span class="chapter-number">${escapeHtml(doc.chapterNumber)}</span>: ` : ''}${escapeHtml(doc.title)}</span></div>
        <button class="doc-menu-btn" data-doc-menu="${doc.id}" title="Меню"><i class="bx bx-dots-vertical-rounded"></i></button>
        <div class="doc-desc">${escapeHtml(doc.description || doc.summary || 'Без описания')}</div>
        ${isBook ? `
        <div class="book-card-footer">
          <span class="book-status-inline status-${this.statusSlug(doc.bookStatus)}">${escapeHtml(doc.bookStatus)}</span>
        </div>
        ` : ''}
      </div>
      `;

      document.querySelectorAll('.doc-item.active').forEach(el => el.classList.remove('active'));

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = docHtml.trim();
      const cardElement = tempDiv.firstChild;
      if (cardElement) {
        folderDocsEl.appendChild(cardElement);
        setTimeout(() => {
          cardElement.classList.remove('new-doc-entrance');
          if (this.state.newlyCreatedId === doc.id) {
            this.state.newlyCreatedId = null;
          }
        }, 1000);
      }
      
      this.setupDocSortables();
      
      this.renderWorkspace();
      this.renderNotes();
      this.renderFloatingNotes();
      this.renderFloatingNoteMenu();
      this.renderFloatingNotesModal();
      this.renderSaveIndicator();
    } else {
      this.renderAll();
    }
  }

  uniqueCopyTitle(baseTitle) {
    const names = new Set(this.state.docs.map((doc) => doc.title));
    const base = `${baseTitle} — копия`;
    if (!names.has(base)) return base;
    let index = 2;
    while (names.has(`${base} ${index}`)) index += 1;
    return `${base} ${index}`;
  }

  async duplicateDoc(id) {
    const source = this.state.docs.find((doc) => doc.id === id);
    if (!source) return;
    const folderDocs = this.state.docs
      .filter((doc) => doc.folderId === source.folderId)
      .sort((a, b) => a.order - b.order);
    const sourceOrder = Number.isFinite(Number(source.order)) ? Number(source.order) : folderDocs.findIndex((doc) => doc.id === id);
    folderDocs.forEach((doc) => {
      if (doc.id !== source.id && Number(doc.order) > sourceOrder) doc.order = Number(doc.order) + 1;
    });
    const now = Date.now();
    const copy = {
      ...structuredClone(source),
      id: uid('doc'),
      title: this.uniqueCopyTitle(source.title || 'Документ'),
      folderId: source.folderId,
      order: sourceOrder + 1,
      pinned: false,
      locked: false,
      encrypted: undefined,
      createdAt: now,
      updatedAt: now,
      ast: {
        type: 'doc',
        blocks: (source.ast?.blocks?.length ? source.ast.blocks : [{ type: 'paragraph', html: '<br>', align: 'left' }])
          .map((block) => ({ ...structuredClone(block), id: uid('block') })),
      },
      notes: '',
    };
    delete copy.encrypted;
    this.state.docs.push(copy);
    this.docWordBaselines.set(copy.id, countWords(docText(copy.ast)));
    await Promise.all([
      ...folderDocs.filter((doc) => doc.id !== source.id && Number(doc.order) > sourceOrder).map((doc) => this.db.put('docs', doc)),
      this.db.put('docs', copy),
    ]);
    this.selectDoc(copy.id);
    this.toast('Документ продублирован.');
  }

  async importDocuments(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    
    // Show spinner/overlay early if we have files to process
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx bx-file-import"></i>
        </div>
        <h3>Импортируем документы...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    overlay.classList.add('active');
    
    const dumpFiles = files.filter((file) => /\.nocturnedump$/i.test(file.name));
    for (const dumpFile of dumpFiles) {
      await this.handleProjectDumpText(await dumpFile.text(), dumpFile.name);
    }
    const reviewFiles = files.filter((file) => /\.nocturned$/i.test(file.name));
    const docFiles = files.filter((file) => !/\.(nocturned|nocturnedump)$/i.test(file.name));
    if (dumpFiles.length && !reviewFiles.length && !docFiles.length) {
      document.getElementById('import-input').value = '';
      overlay.classList.remove('active');
      return;
    }
    
    const importedDocs = [];
    let failCount = 0;
    const importFolderId = this.defaultFolderId();
    
    for (const file of docFiles) {
      try {
        const title = file.name.replace(/\.[^.]+$/, '');
        const isHtml = /\.html?$/i.test(file.name);
        const isPdf = /\.pdf$/i.test(file.name);
        let blocks;
        if (isPdf) {
          const text = await this.extractTextFromPdf(file);
          blocks = this.blocksFromImportedText(text, false);
        } else if (/\.docx$/i.test(file.name)) {
          blocks = await this.blocksFromDocxFile(file);
        } else {
          blocks = this.blocksFromImportedText(await file.text(), isHtml);
        }
        const doc = {
          id: uid('doc'),
          folderId: importFolderId,
          title,
          description: `Импортировано из ${file.name}`,
          order: this.state.docs.filter((item) => item.folderId === importFolderId).length,
          notes: '',
          globalNotes: '',
          summary: `Импортировано из ${file.name}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ast: { type: 'doc', blocks },
        };
        this.state.docs.push(doc);
        this.docWordBaselines.set(doc.id, countWords(docText(doc.ast)));
        await this.db.put('docs', doc);
        this.state.activeDocId = doc.id;
        importedDocs.push({ doc, file });
      } catch (err) {
        console.error('File import error:', err);
        failCount++;
      }
    }
    
    for (const reviewFile of reviewFiles) {
      const payload = await this.readNocturnedFile(reviewFile);
      if (!payload) {
        failCount++;
        continue;
      }
      const target = this.findNocturnedTargetDoc(payload, importedDocs);
      if (target) await this.importNocturnedIntoDoc(payload, target);
      else this.queueNocturnedImportModal(payload, reviewFile.name);
    }
    
    if (importedDocs.length) {
      const lastDoc = importedDocs.at(-1).doc;
      const paneId = this.state.workspace?.mode === 'split' ? this.state.workspace.focusedPaneId : 'primary';
      const pane = this.getPane(paneId) || this.getPane('primary');
      if (pane) Object.assign(pane, { type: 'document', docId: lastDoc.id, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null });
      this.state.activeDocId = lastDoc.id;
      this.persistWorkspaceState();
    }
    document.getElementById('import-input').value = '';
    
    await this.animateDocImport(importedDocs, reviewFiles.length, failCount);
  }

  async extractTextFromPdf(file) {
    try {
      const pdfjsLib = await import('https://unpkg.com/pdfjs-dist@4.3.136/build/pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@4.3.136/build/pdf.worker.min.mjs';
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        let pageText = '';
        let lastY = null;
        let lastX = null;
        let lastWidth = null;
        let lastHeight = null;
        for (const item of textContent.items) {
          const str = item.str;
          const y = item.transform ? item.transform[5] : null;
          const x = item.transform ? item.transform[4] : null;
          const w = item.width || 0;
          const h = item.height || (item.transform ? Math.abs(item.transform[3]) : 12);
          if (lastY !== null && y !== null) {
            const diff = Math.abs(y - lastY);
            if (diff > 5) {
              if (lastHeight !== null && diff > lastHeight * 1.9) {
                pageText += '\n\n';
              } else {
                if (/[a-zA-Zа-яА-ЯёЁ]-\s*$/.test(pageText)) {
                  pageText = pageText.replace(/-\s*$/, '');
                } else if (pageText && !pageText.endsWith(' ') && !pageText.endsWith('\n') && !pageText.endsWith('\n\n')) {
                  pageText += ' ';
                }
              }
            } else if (str && pageText && !pageText.endsWith('\n') && !pageText.endsWith(' ') && !pageText.endsWith('\n\n') && !str.startsWith(' ')) {
              if (x !== null && lastX !== null && lastWidth !== null) {
                const gap = x - (lastX + lastWidth);
                if (gap > h * 0.18) {
                  pageText += ' ';
                }
              }
            }
          }
          pageText += str;
          if (y !== null) lastY = y;
          if (x !== null) lastX = x;
          lastWidth = w;
          if (h) lastHeight = h;
        }
        pages.push(pageText);
      }
      
      const joinPages = (p1, p2) => {
        const t1 = p1.trimEnd();
        const t2 = p2.trimStart();
        if (!t1) return t2;
        if (!t2) return t1;
        const lastChar = t1.slice(-1);
        const isSentenceEnd = /[.!?…”"»]/.test(lastChar);
        const isParagraphStart = /^[—\-–A-ZА-ЯЁ]/.test(t2);
        if (isSentenceEnd && isParagraphStart) {
          return t1 + '\n\n' + t2;
        }
        if (/[a-zA-Zа-яА-ЯёЁ]-\s*$/.test(t1)) {
          return t1.replace(/-\s*$/, '') + t2;
        }
        return t1 + ' ' + t2;
      };
      
      let fullText = '';
      for (const p of pages) {
        fullText = joinPages(fullText, p);
      }
      return fullText;
    } catch (err) {
      console.error('PDF import error:', err);
      throw new Error('Убедитесь, что вы подключены к интернету.');
    }
  }

  async blocksFromDocxFile(file) {
    try {
      const ZipClass = (typeof JSZip !== 'undefined' ? JSZip : null) || (typeof window !== 'undefined' ? window.JSZip : null);
      if (!ZipClass) throw new Error('JSZip библиотека не найдена.');
      const zip = await ZipClass.loadAsync(await file.arrayBuffer());
      const docXmlFile = zip.file('word/document.xml');
      if (!docXmlFile) throw new Error('Не найден файл word/document.xml внутри DOCX архива.');
      const xml = await docXmlFile.async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const paragraphs = [...doc.getElementsByTagName('w:p')];
      const blocks = paragraphs.map((p) => {
        const style = p.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') || '';
        const text = [...p.getElementsByTagName('w:t')].map((node) => node.textContent || '').join('');
        const type = /^Heading[123]$/i.test(style) || style === 'Subtitle' ? 'heading' : style === 'Quote' ? 'quote' : 'paragraph';
        return { id: uid('block'), type, align: 'left', html: escapeHtml(text.trim()) || '<br>' };
      }).filter((block) => block && (block.html !== '<br>' || block.type !== 'heading'));
      return blocks.length ? blocks : [{ id: uid('block'), type: 'paragraph', align: 'left', html: '<br>' }];
    } catch (error) {
      this.toast(`DOCX импорт не удался: ${error.message}`);
      return [{ id: uid('block'), type: 'paragraph', align: 'left', html: '<br>' }];
    }
  }

  readStoredZip(buffer) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    const files = {};
    let offset = 0;
    while (offset + 30 < buffer.byteLength && view.getUint32(offset, true) === 0x04034b50) {
      const method = view.getUint16(offset + 8, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const fileNameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      const dataStart = nameStart + fileNameLength + extraLength;
      const name = decoder.decode(new Uint8Array(buffer, nameStart, fileNameLength));
      if (method === 0) files[name] = decoder.decode(new Uint8Array(buffer, dataStart, compressedSize));
      else if (method === 8) throw new Error('Импорт DOCX поддерживает документы, экспортированные Nocturne. Сжатые Word DOCX пока не распаковываются.');
      offset = dataStart + compressedSize;
    }
    return files;
  }

  async readNocturnedFile(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.format !== 'nocturne-review-delta' || payload.version !== 1) throw new Error('неподдерживаемый формат');
      return payload;
    } catch (error) {
      this.toast(`Не удалось прочитать .nocturned: ${error.message}`);
      return null;
    }
  }

  findNocturnedTargetDoc(payload, importedDocs = []) {
    const hash = payload?.document?.normalizedTextHash;
    const matches = [
      ...importedDocs.map(({ doc }) => doc),
      ...this.state.docs,
    ].filter((doc, index, arr) => doc && arr.findIndex((item) => item.id === doc.id) === index && this.documentPortableHash(doc) === hash);
    return matches.length === 1 ? matches[0] : null;
  }

  queueNocturnedImportModal(payload, filename) {
    this.nocturnedImportQueue.push({ payload, filename });
    if (!this.nocturnedImportModalOpen) this.openNextNocturnedImportModal();
  }

  openNextNocturnedImportModal() {
    const next = this.nocturnedImportQueue.shift();
    if (!next) {
      this.nocturnedImportModalOpen = false;
      return;
    }
    this.nocturnedImportModalOpen = true;
    this.openNocturnedImportModal(next.payload, next.filename);
  }

  openNocturnedImportModal(payload, filename) {
    const overlay = document.getElementById('form-overlay');
    const expectedHash = payload.document?.normalizedTextHash;
    const hasExactMatch = this.state.docs.some((doc) => this.documentPortableHash(doc) === expectedHash);
    const matchStatus = hasExactMatch ? 'Совпадает' : 'Не найдено точного совпадения';
    const options = this.state.docs.map((doc) => `<option value="${doc.id}" ${this.documentPortableHash(doc) === payload.document?.normalizedTextHash ? 'selected' : ''}>${escapeHtml(doc.title)}</option>`).join('');
    overlay.innerHTML = `<div class="form-modal nocturned-import-modal">
      <h2>Импорт редакторских правок</h2>
      <p class="form-helper">${escapeHtml(filename)} относится к «${escapeHtml(payload.document?.title || 'документу')}».</p>
      <p class="form-helper">Совпадение текста: ${escapeHtml(matchStatus)}</p>
      <label>Целевой документ<select class="modal-select" id="nocturned-target-doc">${options}</select></label>
      <div class="form-actions"><button class="pill-btn" data-close-form>Отмена</button><button class="pill-btn ai-btn" id="apply-nocturned">Импортировать правки</button></div>
    </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => {
      overlay.classList.remove('active');
      this.openNextNocturnedImportModal();
    };
    overlay.querySelector('#apply-nocturned').onclick = async () => {
      const doc = this.state.docs.find((item) => item.id === overlay.querySelector('#nocturned-target-doc').value);
      if (doc) await this.importNocturnedIntoDoc(payload, doc);
      overlay.classList.remove('active');
      this.renderAll();
      this.openNextNocturnedImportModal();
    };
  }

  async importNocturnedIntoDoc(payload, doc) {
    const marks = (payload.reviewMarks || []).map((mark) => this.nocturnedMarkToLocal(mark, doc)).filter(Boolean);
    await Promise.all(marks.map((mark) => this.db.put('reviewMarks', mark)));
    this.state.reviewMarks = [...this.state.reviewMarks, ...marks];
    this.updateReviewHighlights();
    this.renderReviewNavigator();
    this.toast(`Импортировано правок: ${marks.length}`);
  }

  nocturnedMarkToLocal(mark, doc) {
    const anchor = this.resolvePortableAnchor(mark, doc);
    return this.sanitizeReviewMark({
      id: uid('review'), sourceExternalId: mark.externalId || null, docId: doc.id,
      kind: mark.kind, category: mark.category, colorKey: mark.colorKey || mark.category,
      quote: mark.quote || '', prefix: mark.prefix || '', suffix: mark.suffix || '',
      start: anchor.start, end: anchor.end, comment: mark.comment || '', suggestion: mark.suggestion || '',
      status: mark.status || 'open', unresolvedRange: anchor.unresolvedRange,
      createdAt: mark.createdAt || Date.now(), updatedAt: mark.updatedAt || Date.now(),
    });
  }

  resolvePortableAnchor(mark, doc) {
    const blocks = doc.ast?.blocks || [];
    const portable = mark.portableAnchor || {};
    const block = blocks[portable.blockIndex];
    const make = (target, start, end, unresolvedRange = false) => ({
      start: { blockId: target?.id || blocks[0]?.id || uid('block'), offset: Math.max(0, start) },
      end: { blockId: target?.id || blocks[0]?.id || uid('block'), offset: Math.max(0, end) },
      unresolvedRange,
    });
    if (block) {
      const text = blockText(block);
      if (this.textHash(text) === portable.blockTextHash) return make(block, portable.startOffset || 0, portable.endOffset || portable.startOffset || 0);
      const found = mark.quote ? this.findBestQuoteOffset(text, mark.quote, mark.prefix, mark.suffix) : -1;
      if (found >= 0) return make(block, found, found + mark.quote.length);
    }
    if (mark.quote) {
      const candidates = [];
      for (const candidate of blocks) {
        const text = blockText(candidate);
        const found = this.findBestQuoteOffset(text, mark.quote, mark.prefix, mark.suffix);
        if (found >= 0) candidates.push({ candidate, found });
      }
      if (candidates.length === 1) return make(candidates[0].candidate, candidates[0].found, candidates[0].found + mark.quote.length);
    }
    return make(blocks[0], 0, 0, true);
  }

  blocksFromImportedText(source, isHtml = false) {
    if (isHtml) {
      const div = document.createElement('div');
      div.innerHTML = source;
      const nodes = [...div.querySelectorAll('h1,h2,h3,p,blockquote')];
      if (nodes.length) {
        return nodes.map((node) => ({
          id: uid('block'),
          type: node.tagName.toLowerCase().startsWith('h') ? 'heading' : node.tagName.toLowerCase() === 'blockquote' ? 'quote' : 'paragraph',
          align: node.style.textAlign || 'left',
          html: normalizeHtml(node.innerHTML || node.textContent) || '<br>',
        }));
      }
    }
    const text = source.replace(/\r/g, '').trim();
    const parts = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    const firstLineLooksLikeTitle = parts.length > 1
      && source.replace(/\r/g, '').trimStart().startsWith(parts[0])
      && /^\s*#{1,3}\s+/.test(parts[0]);
    return (parts.length ? parts : ['']).map((part, index) => ({
      id: uid('block'),
      type: index === 0 && firstLineLooksLikeTitle ? 'heading' : /^>\s?/.test(part) ? 'quote' : 'paragraph',
      align: 'left',
      html: part.replace(/^\s*#{1,3}\s+/, '').replace(/^>\s?/, '').split('\n').map((line) => escapeHtml(line)).join('<br>') || '<br>',
    }));
  }

  confirmDeleteDoc(id) {
    const doc = this.state.docs.find((item) => item.id === id);
    if (!doc) return;
    this.closeAllFloatingMenus();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-trash"></i></div>
        <h2>Удалить документ?</h2>
        <p>«${escapeHtml(doc.title)}» будет удален из локальной базы.</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn danger-btn" data-confirm-delete="${doc.id}">Удалить</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-confirm-delete]').onclick = async () => {
      overlay.classList.remove('active');
      const docEl = document.querySelector(`.doc-item[data-doc-id="${doc.id}"]`);
      this.animateShatter(docEl, async () => {
        if (docEl) {
          const parentGrid = docEl.parentElement;
          const folderId = doc.folderId;
          this.animateLayoutTransition(parentGrid, () => {
            docEl.remove();
            if (parentGrid && parentGrid.children.length === 0) {
              parentGrid.innerHTML = this.folderEmptyState(folderId);
            }
          });
        }
        await this.deleteDoc(doc.id, true);
      });
    };
  }

  async deleteDoc(id, localOnly = false) {
    const doc = this.state.docs.find((item) => item.id === id);
    if (!doc) return;
    await this.db.delete('docs', doc.id);
    await this.deleteFloatingNotesForLink('document', doc.id);
    const docMarks = this.state.reviewMarks.filter((mark) => mark.docId === doc.id);
    await Promise.all(docMarks.map((mark) => this.db.delete('reviewMarks', mark.id)));
    this.state.reviewMarks = this.state.reviewMarks.filter((mark) => mark.docId !== doc.id);
    this.state.docs = this.state.docs.filter((item) => item.id !== doc.id);
    
    let activeChanged = false;
    if (this.state.activeDocId === id) {
      this.state.activeDocId = this.state.docs[0]?.id || null;
      activeChanged = true;
    }
    if (this.state.suggestion?.docId === id) this.clearSuggestion();
    safeRemoveStorageItem(localStorage, `${LIVE_PREFIX}${doc.id}`);
    const snapshots = (await this.db.getAll('snapshots')).filter((snap) => snap.docId === doc.id);
    await Promise.all(snapshots.map((snap) => this.db.delete('snapshots', snap.id)));
    
    let openedInPane = false;
    Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
      if (pane.type === 'document' && pane.docId === id) {
        Object.assign(pane, this.emptyPaneDescriptor(pane.id));
        openedInPane = true;
      }
    });
    this.persistWorkspaceState();
    
    if (localOnly) {
      if (openedInPane || activeChanged) {
        this.renderAll();
      }
    } else {
      this.renderAll();
    }
  }

  async deleteFloatingNotesForLink(scope, linkedId) {
    const doomed = this.state.floatingNotes.filter((note) => note.scope === scope && note.linkedId === linkedId);
    if (!doomed.length) return;
    this.state.floatingNotes = this.state.floatingNotes.filter((note) => !(note.scope === scope && note.linkedId === linkedId));
    await Promise.all(doomed.filter((note) => !note.temporary).map((note) => this.db.delete('floatingNotes', note.id)));
    this.renderFloatingNotes();
    this.renderFloatingNotesModal();
  }

  pinDoc(id) {
    const doc = this.state.docs.find((d) => d.id === id);
    if (!doc) return;
    doc.pinned = !doc.pinned;
    this.saveDocByIdDebounced(id);
    this.renderDocs();
  }

  editDocForm(id) {
    const doc = this.state.docs.find((d) => d.id === id);
    if (!doc) return;
    this.closeAllFloatingMenus();
    const overlay = document.getElementById('form-overlay');
    const isBook = doc.docType === 'book-chapter';
    overlay.innerHTML = `
      <form class="form-modal doc-form" id="edit-doc-form" novalidate>
        <h2>Редактировать документ</h2>
        
        <div class="doc-type-switcher">
          <label class="doc-type-radio"><input type="radio" name="docType" value="document" ${!isBook ? 'checked' : ''}> <span><i class="bx bx-file"></i> Обычный документ</span></label>
          <label class="doc-type-radio"><input type="radio" name="docType" value="book-chapter" ${isBook ? 'checked' : ''}> <span><i class="bx bx-book-open"></i> Глава книги</span></label>
        </div>

        <div class="form-grid">
          <label><span class="doc-title-label">${isBook ? 'Название главы' : 'Название'}</span> <input class="form-control" name="title" value="${escapeHtml(doc.title)}" required></label>
          <label>Описание <textarea class="form-control" name="description">${escapeHtml(doc.description || '')}</textarea></label>
        </div>

        <div class="book-chapter-fields-wrapper ${isBook ? 'open' : ''}">
          <div class="form-grid book-chapter-fields">
            <label>Произведение <input class="form-control" name="workTitle" value="${escapeHtml(doc.workTitle || '')}" placeholder="Название произведения"></label>
            <label>Том <input class="form-control" name="volume" value="${escapeHtml(doc.volume || '')}" placeholder="Например: Том 1"></label>
            <label>Глава <input class="form-control" name="chapterNumber" value="${escapeHtml(doc.chapterNumber || '')}" placeholder="Например: 1 или Глава 1"></label>
            <label>Статус
              <div class="nocturne-select" id="book-status-select" style="width: 100%;">
                <input type="hidden" name="bookStatus" value="${escapeHtml(doc.bookStatus || 'Не редактировано')}">
                <button type="button" class="nocturne-select-trigger" data-setting-select-toggle style="width: 100%;">
                  <span>${escapeHtml(doc.bookStatus || 'Не редактировано')}</span>
                  <i class="bx bx-chevron-down"></i>
                </button>
                <div class="nocturne-select-menu popover-surface" role="listbox" aria-hidden="true" style="width: 100%; min-width: 100%;">
                  ${['Не редактировано', 'На редакции', 'Вычитка', 'Чистовая версия', 'Закончено'].map(status => `
                    <button type="button" class="nocturne-select-option ${doc.bookStatus === status ? 'selected' : (!doc.bookStatus && status === 'Не редактировано' ? 'selected' : '')}" role="option" data-book-status-option data-value="${escapeHtml(status)}">
                      <span>${escapeHtml(status)}</span>
                      <i class="bx bx-check"></i>
                    </button>
                  `).join('')}
                </div>
              </div>
            </label>
          </div>
        </div>

        <div class="form-actions">
          <button class="pill-btn" type="button" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" type="submit">Сохранить</button>
        </div>
      </form>
    `;
    overlay.classList.add('active');
    
    const typeRadios = overlay.querySelectorAll('input[name="docType"]');
    const bookFieldsWrapper = overlay.querySelector('.book-chapter-fields-wrapper');
    typeRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        const titleLabel = overlay.querySelector('.doc-title-label');
        if (radio.value === 'book-chapter') {
          bookFieldsWrapper.classList.add('open');
          if (titleLabel) titleLabel.textContent = 'Название главы';
        } else {
          bookFieldsWrapper.classList.remove('open');
          if (titleLabel) titleLabel.textContent = 'Название';
        }
      });
    });

    const setupCustomStatusSelect = (formEl) => {
      const selectEl = formEl.querySelector('#book-status-select');
      if (!selectEl) return;
      const trigger = selectEl.querySelector('[data-setting-select-toggle]');
      const hiddenInput = selectEl.querySelector('input[name="bookStatus"]');
      const options = selectEl.querySelectorAll('[data-book-status-option]');
      
      options.forEach(opt => {
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = opt.dataset.value;
          hiddenInput.value = val;
          trigger.querySelector('span').textContent = val;
          options.forEach(o => o.classList.toggle('selected', o === opt));
          this.closeSettingsSelects();
        });
      });
    };
    setupCustomStatusSelect(overlay);

    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      if (!this.validateForm(e.target)) return;
      const data = Object.fromEntries(new FormData(e.target));
      
      doc.docType = data.docType || 'document';
      doc.title = data.title.trim() || doc.title;
      doc.description = data.description.trim();
      
      if (doc.docType === 'book-chapter') {
        doc.workTitle = data.workTitle?.trim() || '';
        doc.volume = data.volume?.trim() || '';
        doc.chapterNumber = data.chapterNumber?.trim() || '';
        doc.bookStatus = data.bookStatus || 'Не редактировано';
      } else {
        delete doc.workTitle;
        delete doc.volume;
        delete doc.chapterNumber;
        delete doc.bookStatus;
      }
      
      const copy = this.sanitizeDoc(doc);
      Object.assign(doc, copy); // preserve reference in memory
      
      overlay.classList.remove('active');
      setTimeout(async () => {
        doc.updatedAt = Date.now();
        await this.db.put('docs', doc);
        this.renderAll();
      }, 100);
    };
  }

  toggleFolder(folderId) {
    const idx = this.state.collapsedFolders.indexOf(folderId);
    if (idx >= 0) this.state.collapsedFolders.splice(idx, 1);
    else this.state.collapsedFolders.push(folderId);
    safeSetStorageItem(localStorage, 'nocturne-collapsed-folders', JSON.stringify(this.state.collapsedFolders));
    this.renderDocs();
    this.renderMobileShell();
  }

  cleanupSortableDragState() {
    document.body.classList.remove('sortable-active');
    document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    const selectors = ['.sortable-drag', '.sortable-fallback-drag', '.sortable-ghost', '.sortable-chosen'];
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        if (el.parentNode === document.body || el.style.position === 'absolute' || el.style.position === 'fixed') {
          el.remove();
        }
      });
    });
  }

  setupDocSortables() {
    this.docSortables?.forEach((sortable) => sortable.destroy?.());
    this.docSortables = [];
    if (!window.Sortable || this.state.docSearch.trim()) return;
    document.querySelectorAll('.folder-docs').forEach((zone) => {
      const folderId = zone.previousElementSibling?.dataset.folderId;
      if (!folderId) return;
      const sortable = new window.Sortable(zone, {
        group: 'docs',
        animation: 250,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        forceFallback: true,
        fallbackOnBody: true,
        fallbackClass: 'sortable-drag',
        ghostClass: 'sortable-ghost',
        filter: '.doc-menu-btn, .doc-context-menu, button',
        preventOnFilter: false,
        onStart: (event) => {
          document.body.classList.add('sortable-active');
          window.getSelection()?.removeAllRanges();
          event.from.classList.add('is-dragging');
          this.captureDocDragSnapshot(event);
          this.beginDocPaneDrag(event.item?.dataset.docId);
        },
        onEnd: async (event) => {
          const paneDrop = this.finishDocPaneDrag();
          document.body.classList.remove('sortable-active');
          event.from.classList.remove('is-dragging');
          event.to.classList.remove('is-dragging');
          if (paneDrop) {
            this.renderDocs();
            this.kbSuppressClickUntil = Date.now() + 360;
            return;
          }
          if (this.shouldCancelSingleModeDocDrag(event)) {
            await this.restoreDocDragSnapshot();
            this.kbSuppressClickUntil = Date.now() + 260;
            return;
          }
          await this.persistDocsDomOrder();
          this.docDragSnapshot = null;
          this.renderDocs();
          this.kbSuppressClickUntil = Date.now() + 260;
        },
      });
      zone.__sortable = sortable;
      this.docSortables.push(sortable);
    });
  }

  captureDocDragSnapshot(event) {
    this.docDragSnapshot = {
      mode: this.state.workspace?.mode || 'single',
      docCount: this.state.docs.length,
      docs: this.state.docs.map((doc) => ({ id: doc.id, folderId: doc.folderId, order: doc.order })),
      docId: event.item?.dataset.docId || null,
      fromFolderId: event.from?.previousElementSibling?.dataset.folderId || null,
    };
  }

  shouldCancelSingleModeDocDrag(event) {
    if (this.docDragSnapshot?.mode === 'split' || this.state.workspace?.mode === 'split') return false;
    const toFolder = event.to?.classList?.contains('folder-docs') ? event.to : null;
    const fromFolder = event.from?.classList?.contains('folder-docs') ? event.from : null;
    if (!toFolder || !fromFolder) return true;
    const pointer = event.originalEvent;
    const x = pointer?.clientX;
    const y = pointer?.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const dropTarget = document.elementFromPoint(x, y);
    return !dropTarget?.closest?.('.folder-docs, .doc-item, .docs-container');
  }

  async restoreDocDragSnapshot() {
    const snapshot = this.docDragSnapshot;
    this.docDragSnapshot = null;
    if (!snapshot) return;
    const byId = new Map(snapshot.docs.map((doc) => [doc.id, doc]));
    const accidental = this.state.docs.filter((doc) => !byId.has(doc.id));
    await Promise.all(accidental.map((doc) => this.db.delete('docs', doc.id)));
    this.state.docs = this.state.docs
      .filter((doc) => byId.has(doc.id))
      .map((doc) => ({ ...doc, folderId: byId.get(doc.id).folderId, order: byId.get(doc.id).order }));
    this.renderDocs();
    this.toast('Перетаскивание вне списка отменено.');
  }

  beginDocPaneDrag(docId) {
    if (!docId || this.state.workspace?.mode !== 'split') {
      this.docPaneDropState = null;
      document.body.classList.remove('doc-pane-drop-active');
      return;
    }
    this.docPaneDropState = { docId, hoverPaneId: null, dropped: false };
    document.body.classList.add('doc-pane-drop-active');
    document.querySelectorAll('.workspace-pane').forEach((pane) => {
      pane.classList.add('drop-available');
      this.updatePaneDropLabel(pane.dataset.paneId);
    });
  }

  handleDocPaneDragMove(event) {
    if (!this.docPaneDropState || this.state.workspace?.mode !== 'split') return;
    const pane = [...document.querySelectorAll('.workspace-pane[data-pane-id]')].find((item) => {
      const rect = item.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    const paneId = pane?.dataset.paneId || null;
    if (this.docPaneDropState.hoverPaneId === paneId) return;
    this.docPaneDropState.hoverPaneId = paneId;
    document.querySelectorAll('.workspace-pane').forEach((item) => {
      item.classList.toggle('drop-hover', item.dataset.paneId === paneId);
      this.updatePaneDropLabel(item.dataset.paneId);
    });
  }

  handleDocPaneDragEnd() {
    if (!this.docPaneDropState) return;
    if (this.docPaneDropState.hoverPaneId) this.docPaneDropState.dropped = true;
  }

  finishDocPaneDrag() {
    const state = this.docPaneDropState;
    this.docPaneDropState = null;
    document.body.classList.remove('doc-pane-drop-active');
    document.querySelectorAll('.workspace-pane').forEach((pane) => pane.classList.remove('drop-available', 'drop-hover'));
    if (!state?.dropped || !state.hoverPaneId || this.state.workspace?.mode !== 'split') return false;
    const doc = this.state.docs.find((item) => item.id === state.docId);
    if (!doc) return false;
    const result = this.applyDocumentPaneDrop(doc.id, state.hoverPaneId);
    if (!result) return true;
    this.toast(result === 'swap' ? 'Документы поменялись областями.' : result === 'move' ? 'Документ перемещён в другую область.' : (state.hoverPaneId === 'primary' ? 'Документ открыт слева.' : 'Документ открыт справа.'));
    return true;
  }

  paneIdForOpenDoc(docId) {
    return Object.values(this.state.workspace?.panes || {}).find((pane) => pane.type === 'document' && pane.docId === docId)?.id || null;
  }

  clonePaneDescriptor(pane) {
    return {
      id: pane.id,
      type: pane.type || null,
      docId: pane.docId || null,
      entityType: pane.entityType || null,
      entityId: pane.entityId || null,
      kbTab: pane.kbTab || null,
      subtimelineParentId: pane.subtimelineParentId || null,
    };
  }

  dropIntentForPane(docId, targetPaneId) {
    const sourcePaneId = this.paneIdForOpenDoc(docId);
    const target = this.getPane(targetPaneId);
    if (!targetPaneId || !target) return { kind: 'none', label: '' };
    if (sourcePaneId === targetPaneId) return { kind: 'same', label: 'Уже открыт здесь' };
    if (sourcePaneId && target?.type) return { kind: 'swap', label: 'Поменять документы местами' };
    if (sourcePaneId && !target?.type) return { kind: 'move', label: 'Переместить сюда' };
    if (!target?.type) return { kind: 'open', label: 'Открыть здесь' };
    return { kind: 'replace', label: 'Открыть здесь' };
  }

  updatePaneDropLabel(paneId) {
    if (!paneId || !this.docPaneDropState) return;
    const pane = document.querySelector(`.workspace-pane[data-pane-id="${paneId}"]`);
    const label = pane?.querySelector('.pane-drop-overlay span');
    if (!label) return;
    label.textContent = this.dropIntentForPane(this.docPaneDropState.docId, paneId).label || 'Открыть здесь';
  }

  applyDocumentPaneDrop(docId, targetPaneId) {
    const target = this.getPane(targetPaneId);
    const sourcePaneId = this.paneIdForOpenDoc(docId);
    const source = sourcePaneId ? this.getPane(sourcePaneId) : null;
    if (!target || sourcePaneId === targetPaneId) return null;
    const changedPaneIds = [sourcePaneId, targetPaneId].filter(Boolean);
    const targetSnapshot = this.clonePaneDescriptor(target);
    if (source) {
      const sourceSnapshot = this.clonePaneDescriptor(source);
      Object.assign(target, sourceSnapshot, { id: targetPaneId });
      Object.assign(source, targetSnapshot.type ? targetSnapshot : { type: null, docId: null, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null }, { id: sourcePaneId });
    } else {
      Object.assign(target, { type: 'document', docId, entityType: null, entityId: null, kbTab: null, subtimelineParentId: null, id: targetPaneId });
    }
    this.state.workspace.focusedPaneId = targetPaneId;
    this.state.activeDocId = docId;
    this.persistWorkspaceState();
    this.renderWorkspace();
    this.renderFloatingNotes();
    this.animatePaneContentRefresh(changedPaneIds.length ? changedPaneIds : [targetPaneId]);
    return source ? (targetSnapshot.type ? 'swap' : 'move') : 'replace';
  }

  animatePaneContentRefresh(paneIds = []) {
    const panes = paneIds
      .map((paneId) => document.querySelector(`.workspace-pane[data-pane-id="${paneId}"] .workspace-pane-body`))
      .filter(Boolean);
    panes.forEach((pane) => {
      pane.classList.remove('pane-content-refreshing');
      void pane.offsetWidth;
      pane.classList.add('pane-content-refreshing');
      window.setTimeout(() => pane.classList.remove('pane-content-refreshing'), 220);
    });
  }

  async persistDocsDomOrder() {
    const updates = [];
    document.querySelectorAll('.folder-docs').forEach((zone) => {
      const folderId = zone.previousElementSibling?.dataset.folderId;
      if (!folderId) return;
      [...zone.querySelectorAll('.doc-item')].forEach((item, order) => {
        const doc = this.state.docs.find((entry) => entry.id === item.dataset.docId);
        if (!doc) return;
        doc.folderId = folderId;
        doc.order = order;
        updates.push(this.db.put('docs', doc));
      });
    });
    await Promise.all(updates);
  }

  selectDoc(id) {
    this.cleanupSortableDragState();
    this.saveActiveDoc({ silent: true });
    this.clearSuggestionIfStale();
    const existingPaneId = this.paneIdForOpenDoc(id);
    if (existingPaneId && this.state.workspace?.mode === 'split') {
      this.setFocusedPane(existingPaneId);
      this.toast('Документ уже открыт в другой области.');
      return;
    }
    const paneId = this.state.workspace?.mode === 'split' ? this.state.workspace.focusedPaneId : 'primary';
    this.openInPane(paneId, { type: 'document', docId: id });
    this.state.activeDocId = id;
    this.renderDocs();
    this.renderNotes();
    this.drawSentiment();
  }

  paginate(ast = this.activeDoc?.ast, paneId = this.state.workspace?.focusedPaneId || 'primary') {
    const doc = this.getDocForPane(paneId) || this.activeDoc;
    if (doc && !this.docWordBaselines.has(doc.id)) {
      this.docWordBaselines.set(doc.id, countWords(docText(doc.ast || ast)));
    }
    const revision = this.ensureDocRenderRevision(doc);
    
    // Get active dimensions
    const activePane = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(paneId)}"]`);
    const activePage = activePane?.querySelector('.page');
    const activeContent = activePane?.querySelector('.page-content');
    
    let maxContentHeight = 931; // A4 page-content height fallback (1123 - 192)
    let targetWidth = 794;
    let realPaddingTop = 96, realPaddingBottom = 96, realPaddingLeft = 96, realPaddingRight = 96;
    
    if (activePage) {
      const pageStyle = window.getComputedStyle(activePage);
      const pageHeight = parseFloat(pageStyle.height) || 1123;
      realPaddingTop = parseFloat(pageStyle.paddingTop) || 96;
      realPaddingBottom = parseFloat(pageStyle.paddingBottom) || 96;
      realPaddingLeft = parseFloat(pageStyle.paddingLeft) || 96;
      realPaddingRight = parseFloat(pageStyle.paddingRight) || 96;
      
      maxContentHeight = pageHeight - realPaddingTop - realPaddingBottom;
      if (activeContent && activeContent.clientHeight) {
        maxContentHeight = activeContent.clientHeight;
      }
      targetWidth = parseFloat(pageStyle.width) || 794;
    }

    if (!this.state.settings.autoPaginate) {
      maxContentHeight = Infinity;
    }
    
    // Create hidden measuring stage in DOM
    let stage = document.getElementById('nocturne-measuring-stage');
    if (!stage) {
      stage = document.createElement('div');
      stage.id = 'nocturne-measuring-stage';
      document.body.appendChild(stage);
    }
    
    const appShell = document.querySelector('.app-shell');
    const appShellClass = appShell ? appShell.className : 'app-shell';
    const workspaceStage = document.querySelector('.workspace-stage');
    const workspaceStageMode = workspaceStage ? workspaceStage.dataset.mode : 'single';
    
    stage.className = document.body.className;
    stage.setAttribute('style', `
      position: absolute;
      visibility: hidden !important;
      pointer-events: none !important;
      width: ${targetWidth}px;
      height: auto;
      top: -9999px;
      left: -9999px;
      overflow: hidden;
    `);
    
    stage.innerHTML = `
      <div class="${appShellClass}">
        <div class="workspace-stage" data-mode="${workspaceStageMode}">
          <div class="workspace-pane" data-pane-id="${paneId}">
            <div class="page" style="width: ${targetWidth}px; height: auto !important; min-height: 0 !important; padding: ${realPaddingTop}px ${realPaddingRight}px ${realPaddingBottom}px ${realPaddingLeft}px !important; margin: 0 !important; border: 0 !important; box-shadow: none !important; box-sizing: border-box;">
              <div class="page-content" style="height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important;">
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    
    const measureContent = stage.querySelector('.page-content');
    if (activeContent) {
      const activeStyle = window.getComputedStyle(activeContent);
      measureContent.style.fontSize = activeStyle.fontSize;
      measureContent.style.fontFamily = activeStyle.fontFamily;
      measureContent.style.lineHeight = activeStyle.lineHeight;
      measureContent.style.letterSpacing = activeStyle.letterSpacing;
      measureContent.style.padding = '0';
    }
    
    const pages = [];
    let currentPageBlocks = [];
    measureContent.innerHTML = '';
    
    // We map blocks to process
    const blocksToProcess = (ast?.blocks || []).map((block, idx) => ({
      ...block,
      index: idx,
      sourceBlockId: block.sourceBlockId || block.id,
      fragmentStart: block.fragmentStart !== undefined ? block.fragmentStart : 0,
      fragmentEnd: block.fragmentEnd !== undefined ? block.fragmentEnd : blockText(block).length,
      fragmentIndex: block.fragmentIndex !== undefined ? block.fragmentIndex : 0,
      isFragment: block.isFragment || false
    }));
    
    while (blocksToProcess.length > 0) {
      const block = blocksToProcess.shift();
      const isHeading = block.type === 'heading';
      
      const blockHtml = this.renderBlocks([block]);
      measureContent.insertAdjacentHTML('beforeend', blockHtml);
      const currentHeight = measureContent.scrollHeight;
      
      if (currentHeight <= maxContentHeight + 1) {
        currentPageBlocks.push(block);
      } else {
        measureContent.lastElementChild?.remove();
        
        if (isHeading || block.type === 'quote' || blockText(block).trim().length < 5) {
          if (currentPageBlocks.length > 0) {
            blocksToProcess.unshift(block);
            pages.push(this.pageDescriptor(currentPageBlocks, revision, doc?.id));
            currentPageBlocks = [];
            measureContent.innerHTML = '';
          } else {
            currentPageBlocks.push(block);
          }
        } else {
          // Binary search word split using DOM measuring
          const text = blockText(block);
          const tokens = text.split(/(\s+)/);
          
          let left = 0;
          let right = tokens.length;
          let bestFitCount = 0;
          
          while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const slice = tokens.slice(0, mid).join('');
            
            const tempBlock = {
              ...block,
              html: escapeHtml(slice).replace(/\n/g, '<br>') || '<br>'
            };
            const tempHtml = this.renderBlocks([tempBlock]);
            
            measureContent.insertAdjacentHTML('beforeend', tempHtml);
            const tempHeight = measureContent.scrollHeight;
            measureContent.lastElementChild?.remove();
            
            if (tempHeight <= maxContentHeight + 1) {
              bestFitCount = mid;
              left = mid + 1;
            } else {
              right = mid - 1;
            }
          }
          
          if (bestFitCount > 0) {
            const slice1 = tokens.slice(0, bestFitCount).join('');
            const slice2 = tokens.slice(bestFitCount).join('');
            
            const splitOffset = slice1.length;
            const originalStart = block.fragmentStart;
            
            currentPageBlocks.push({
              ...block,
              html: escapeHtml(slice1).replace(/\n/g, '<br>') || '<br>',
              isFragment: true,
              fragmentStart: originalStart,
              fragmentEnd: originalStart + splitOffset,
              fragmentIndex: block.fragmentIndex,
            });
            
            if (slice2.length > 0) {
              blocksToProcess.unshift({
                ...block,
                html: escapeHtml(slice2).replace(/\n/g, '<br>') || '<br>',
                isFragment: true,
                fragmentStart: originalStart + splitOffset,
                fragmentEnd: block.fragmentEnd,
                fragmentIndex: block.fragmentIndex + 1,
              });
            }
            
            pages.push(this.pageDescriptor(currentPageBlocks, revision, doc?.id));
            currentPageBlocks = [];
            measureContent.innerHTML = '';
          } else {
            if (currentPageBlocks.length > 0) {
              blocksToProcess.unshift(block);
              pages.push(this.pageDescriptor(currentPageBlocks, revision, doc?.id));
              currentPageBlocks = [];
              measureContent.innerHTML = '';
            } else {
              // Force fit first token if page is empty
              const firstToken = tokens.slice(0, 1).join('');
              const rest = tokens.slice(1).join('');
              
              currentPageBlocks.push({
                ...block,
                html: escapeHtml(firstToken).replace(/\n/g, '<br>') || '<br>',
              });
              
              if (rest.length > 0) {
                blocksToProcess.unshift({
                  ...block,
                  html: escapeHtml(rest).replace(/\n/g, '<br>') || '<br>',
                  isFragment: true,
                  fragmentStart: block.fragmentStart + firstToken.length,
                  fragmentEnd: block.fragmentEnd,
                  fragmentIndex: block.fragmentIndex + 1,
                });
              }
            }
          }
        }
      }
    }
    
    if (currentPageBlocks.length || !pages.length) {
      pages.push(this.pageDescriptor(currentPageBlocks, revision, doc?.id));
    }
    
    stage.remove();
    
    // Recalculate fragment counts and update page descriptors
    const fragmentCounts = {};
    pages.forEach((page) => {
      (page.blocks || []).forEach((b) => {
        if (b.isFragment) {
          fragmentCounts[b.sourceBlockId] = (fragmentCounts[b.sourceBlockId] || 0) + 1;
        }
      });
    });
    
    pages.forEach((page) => {
      if (page.blocks) {
        page.blocks = page.blocks.map((b) => {
          if (b.isFragment) {
            return {
              ...b,
              fragmentCount: fragmentCounts[b.sourceBlockId] || 1
            };
          }
          return b;
        });
        page.blockIds = page.blocks.map((b) => b.id);
      }
    });
    
    this.state.pageStates[paneId] = { docId: doc?.id || null, revision, pages };
    return pages;
  }

  splitLongBlockForPagination(block, blockIndex, maxChars) {
    const text = blockText(block);
    if (text.length <= maxChars) return [{ ...block, index: blockIndex }];
    const fragments = [];
    let start = 0;
    let fragmentIndex = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + maxChars);
      if (end < text.length) {
        const window = text.slice(start, end);
        const boundary = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '), window.lastIndexOf('… '), window.lastIndexOf(' '));
        if (boundary > Math.floor(maxChars * .45)) end = start + boundary + 1;
      }
      const slice = text.slice(start, end);
      fragments.push({
        ...block,
        id: block.id,
        html: escapeHtml(slice).replace(/\n/g, '<br>') || '<br>',
        index: blockIndex,
        sourceBlockId: block.id,
        fragmentIndex,
        fragmentStart: start,
        fragmentEnd: end,
        fragmentCount: 0,
        isFragment: true,
      });
      start = end;
      fragmentIndex += 1;
    }
    return fragments.map((fragment) => ({ ...fragment, fragmentCount: fragments.length }));
  }

  astWithAiPreview(doc, paneId) {
    if (!doc?.ast?.blocks || this.state.suggestion?.docId !== doc.id || this.state.suggestion?.paneId !== paneId) return doc?.ast;
    const suggestion = this.state.suggestion;
    const target = suggestion.target;
    const blocks = doc.ast.blocks.map((block) => ({ ...block }));
    const index = blocks.findIndex((block) => block.id === target?.blockId);
    if (index < 0) return doc.ast;
    const previewText = suggestion.text || '';
    const previewHtml = `<span class="ai-suggestion" data-suggestion-id="${escapeHtml(suggestion.id)}">${escapeHtml(previewText).replace(/\n/g, '<br>')}</span>`;
    if (suggestion.mode === 'new-paragraph') {
      blocks.splice(index + 1, 0, { id: `${suggestion.id}-preview`, type: 'paragraph', html: previewHtml, hasAiPreview: true });
    } else if (suggestion.mode === 'inline-continuation') {
      blocks[index].html = this.replaceInHtmlRangeWithHtml(blocks[index].html, target.startOffset, target.startOffset, previewHtml);
      blocks[index].hasAiPreview = true;
    } else if (suggestion.mode === 'replace-block') {
      blocks[index].html = previewHtml;
      blocks[index].hasAiPreview = true;
    } else {
      blocks[index].html = this.replaceInHtmlRangeWithHtml(blocks[index].html, target.startOffset, target.endOffset, previewHtml);
      blocks[index].hasAiPreview = true;
    }
    return { ...doc.ast, blocks };
  }

  ensureDocRenderRevision(doc) {
    if (!doc) return 0;
    if (!Number.isFinite(doc.renderRevision)) doc.renderRevision = 1;
    return doc.renderRevision;
  }

  bumpDocRenderRevision(doc) {
    if (!doc) return 0;
    doc.renderRevision = this.ensureDocRenderRevision(doc) + 1;
    return doc.renderRevision;
  }

  pageDescriptor(blocks, revision, docId) {
    const start = blocks[0]?.index || 0;
    const end = blocks.at(-1)?.index || start;
    return {
      blocks,
      blockIds: blocks.map((block) => block.id).filter(Boolean),
      start,
      end,
      revision,
      docId,
    };
  }

  renderEditor(paneId = this.state.workspace?.focusedPaneId || 'primary') {
    const doc = this.getDocForPane(paneId) || (paneId === 'primary' ? this.activeDoc : null);
    const container = document.querySelector(`[data-editor-container][data-pane-id="${paneId}"]`);
    if (!doc) {
      if (container) container.innerHTML = '';
      return;
    }
    if (doc.locked) {
      if (container) {
        container.innerHTML = `
          <div class="locked-document-screen">
            <div class="locked-document-card">
              <div class="lock-icon-orb"><i class="bx bxs-lock"></i></div>
              <h3>Документ зашифрован</h3>
              <p>Этот документ защищен сквозным шифрованием (E2E). Введите мастер-пароль сессии для расшифровки.</p>
              <div class="lock-input-group">
                <input type="password" class="form-control lock-password-input" placeholder="Мастер-пароль сессии..." data-doc-id="${doc.id}">
                <button class="pill-btn lock-unlock-btn" data-action="unlock-doc-screen" data-doc-id="${doc.id}"><i class="bx bx-key"></i> Войти</button>
              </div>
            </div>
          </div>
        `;
        const btn = container.querySelector('[data-action="unlock-doc-screen"]');
        const input = container.querySelector('.lock-password-input');
        const performUnlock = async () => {
          const password = input.value;
          if (!password) {
            this.toast('Введите пароль.');
            return;
          }
          this.state.sessionPassword = password;
          safeSetStorageItem(sessionStorage, 'nocturne-master-password', password);
          this.state.docs = await this.loadDocs();
          this.initWorkspace();
          this.renderAll();
          const updatedDoc = this.state.docs.find(d => d.id === doc.id);
          if (updatedDoc && !updatedDoc.locked) {
            this.toast('Документ успешно расшифрован!');
          } else {
            this.toast('Неверный пароль сессии.', 1500);
            this.state.sessionPassword = '';
            safeRemoveStorageItem(sessionStorage, 'nocturne-master-password');
            this.state.docs = await this.loadDocs();
            this.renderAll();
          }
        };
        if (btn) btn.onclick = performUnlock;
        if (input) {
          input.onkeydown = (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              performUnlock();
            }
          };
        }
      }
      return;
    }
    this.nocturneEditor?.destroy(paneId);
    container.innerHTML = `
      <section class="page visual-page-shell" data-pane-id="${paneId}" data-doc-id="${doc.id}" data-page-index="0">
        <div class="cursor-light"></div>
        <div class="page-content pm-editor-host" data-pane-id="${paneId}" data-doc-id="${doc.id}" spellcheck="false"></div>
        <div class="page-overlay" aria-hidden="true"></div>
        <div class="page-number">1</div>
      </section>
    `;
    const host = container.querySelector('.page-content');
    const pageShell = container.querySelector('.page');
    const overlay = container.querySelector('.page-overlay');
    this.nocturneEditor?.mount({
      paneId,
      doc,
      host,
      pageShell,
      overlay,
      readOnly: doc.locked || this.state.reviewMode === 'editor',
    });

    this.updateActiveBlock();
    this.disableBrowserSpellcheck();
    this.applyReviewMode();
  }

  disableBrowserSpellcheck() {
    document.querySelectorAll('.page-content').forEach((editable) => {
      editable.setAttribute('spellcheck', 'false');
      editable.spellcheck = false;
    });
  }

  getCaretSnapshot() {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const anchor = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
    const block = anchor?.closest?.('[data-block-id]');
    const pageContent = anchor?.closest?.('.page-content');
    if (!pageContent) return null;
    const paneId = pageContent.dataset.paneId || pageContent.closest('[data-pane-id]')?.dataset.paneId || this.state.workspace?.focusedPaneId || 'primary';
    const docId = pageContent.dataset.docId || this.getDocForPane(paneId)?.id || null;
    if (block) {
      const range = sel.getRangeAt(0).cloneRange();
      const pre = range.cloneRange();
      pre.selectNodeContents(block);
      try {
        pre.setEnd(range.endContainer, range.endOffset);
      } catch (e) {
        pre.setEnd(block, block.childNodes.length);
      }
      const fragmentBase = Number(block.dataset.fragmentStart || 0);
      const fragmentIndex = block.dataset.fragmentIndex !== undefined ? Number(block.dataset.fragmentIndex) : undefined;
      return {
        paneId,
        docId,
        blockId: block.dataset.sourceBlockId || block.dataset.blockId,
        fragmentIndex,
        offset: fragmentBase + pre.toString().length
      };
    }
    const range = sel.getRangeAt(0).cloneRange();
    const pre = range.cloneRange();
    pre.selectNodeContents(pageContent);
    pre.setEnd(range.endContainer, range.endOffset);
    return { paneId, docId, pageContentOffset: pre.toString().length };
  }

  restoreCaret(snapshot) {
    if (!snapshot) {
      return false;
    }
    let container, remaining;
    const scope = snapshot.paneId ? document.querySelector(`.workspace-pane[data-pane-id="${snapshot.paneId}"]`) : null;
    const editableScope = snapshot.docId
      ? scope?.querySelector(`.page-content[data-doc-id="${CSS.escape(snapshot.docId)}"]`)
      : scope?.querySelector('.page-content');
    if (!scope || !editableScope) return false;
    if (snapshot.blockId) {
      const frags = [...scope.querySelectorAll(`[data-block-id="${CSS.escape(snapshot.blockId)}"], [data-source-block-id="${CSS.escape(snapshot.blockId)}"]`)];
      if (frags.length > 1) {
        container = frags.find((f) => {
          const start = Number(f.dataset.fragmentStart || 0);
          const end = Number(f.dataset.fragmentEnd || 0);
          return snapshot.offset >= start && snapshot.offset <= end;
        }) || frags.at(-1);
      } else {
        container = frags[0] || scope.querySelector(`[data-block-id="${CSS.escape(snapshot.blockId)}"]`);
      }
      if (container) {
        const fragmentStart = container.dataset.fragmentStart !== undefined ? Number(container.dataset.fragmentStart) : 0;
        remaining = Math.max(0, snapshot.offset - fragmentStart);
      }
    } else if (snapshot.pageContentOffset !== undefined) {
      container = editableScope;
      remaining = snapshot.pageContentOffset;
    }
    if (!container) return false;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, {
      acceptNode(n) { return n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && n.tagName === 'BR') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; }
    });
    let node = walker.nextNode();
    while (node) {
      const isBr = node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR';
      const len = isBr ? 0 : node.textContent.length;
      if (len >= remaining || (isBr && remaining === 0)) {
        try {
          const range = document.createRange();
          if (isBr) {
            range.setStartBefore(node);
          } else {
            range.setStart(node, Math.min(remaining, len));
          }
          range.collapse(true);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          
          // Scroll caret container into view if it is out of viewport
          const parentEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          if (parentEl) {
            parentEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        } catch {}
        container.closest('.page-content')?.focus();
        return true;
      }
      remaining -= len;
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.selectNodeContents(container);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    
    // Scroll caret container into view if it is out of viewport
    container.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    
    container.closest('.page-content')?.focus();
    return true;
  }

  repaginatePreserve(paneId = this.state.workspace?.focusedPaneId || 'primary', immediate = false) {
    clearTimeout(this.repaginateTimer);
    const checkAndRepaginate = () => {
      const doc = this.getDocForPane(paneId);
      if (!doc) return;
      
      const oldPages = this.state.pageStates[paneId]?.pages || [];
      const oldPageBlockIds = oldPages.map(p => (p.blocks || []).map(b => b.id).join(','));
      
      const newPages = this.paginate(this.astWithAiPreview(doc, paneId), paneId);
      const newPageBlockIds = newPages.map(p => (p.blocks || []).map(b => b.id).join(','));
      
      const changed = oldPageBlockIds.length !== newPageBlockIds.length || 
                      oldPageBlockIds.some((ids, idx) => ids !== newPageBlockIds[idx]);
                      
      if (changed) {
        const snapshot = this.getCaretSnapshot();
        this.renderEditor(paneId);
        this.restoreCaret(snapshot);
        this.updateCustomCaret();
      } else {
        this.updateCustomCaret();
      }
    };
    if (immediate) {
      checkAndRepaginate();
    } else {
      this.repaginateTimer = setTimeout(checkAndRepaginate, 250);
    }
  }

  renderBlocks(blocks) {
    return blocks.map((block) => {
      const tag = block.type === 'heading' ? 'h2' : block.type === 'quote' ? 'blockquote' : 'p';
      const align = ['left', 'center', 'right', 'justify'].includes(block.align) ? block.align : 'left';
      const fragmentAttrs = block.isFragment
        ? ` data-source-block-id="${escapeHtml(block.sourceBlockId || block.id)}" data-fragment-index="${block.fragmentIndex}" data-fragment-count="${block.fragmentCount}" data-fragment-start="${block.fragmentStart}" data-fragment-end="${block.fragmentEnd}"`
        : '';
      return `<${tag} data-block-id="${escapeHtml(block.sourceBlockId || block.id)}"${fragmentAttrs} style="text-align:${align}">${this.decorateBlock(block)}</${tag}>`;
    }).join('');
  }

  decorateBlock(block) {
    if (block.hasAiPreview) return normalizeHtml(block.html || '<br>');
    const settings = this.state.settings;
    let html = cleanAnalysisResidue(block.html || '');
    if (settings.writerSyntax && block.type !== 'heading') html = this.decorateWriterSyntax(html);
    if (settings.showDontTell && block.type !== 'heading') html = this.decorateWeakWords(html);
    html = this.decorateEntities(html);
    return html || '<br>';
  }

  updateReadabilityHighlights(options = {}) {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    CSS.highlights.delete('sentence-short');
    CSS.highlights.delete('sentence-long');
    if (!this.state.settings.readability) return;

    const active = options.skipActiveSentence ? this.getCaretSnapshot() : null;
    const shortRanges = [];
    const longRanges = [];
    document.querySelectorAll('.page-content p').forEach((block) => {
      const textNodes = [];
      let fullText = '';
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      let node = walker.nextNode();
      while (node) {
        const text = cleanAnalysisResidue(node.nodeValue || '');
        textNodes.push({ node, start: fullText.length, end: fullText.length + text.length });
        fullText += text;
        node = walker.nextNode();
      }

      const sentenceRegex = /[^.!?…]+[.!?…]+/gu;
      let match = sentenceRegex.exec(fullText);
      while (match) {
        const sentence = match[0];
        const start = match.index;
        const end = start + sentence.length;
        const isActiveSentence = active?.blockId === block.dataset.blockId && active.offset >= start && active.offset <= end;
        if (sentence.trim() && !isActiveSentence) {
          const words = countWords(sentence);
          if (words > 24 || words <= 7) {
            const range = this.rangeFromBlockOffsets(textNodes, start, end);
            if (range) {
              if (words > 24) longRanges.push(range);
              else shortRanges.push(range);
            }
          }
        }
        match = sentenceRegex.exec(fullText);
      }
    });
    if (shortRanges.length) CSS.highlights.set('sentence-short', new Highlight(...shortRanges));
    if (longRanges.length) CSS.highlights.set('sentence-long', new Highlight(...longRanges));
  }

  updateTypoHighlights() {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    CSS.highlights.delete('typo-errors');
    CSS.highlights.delete('typo-smart-errors');
    this.typoMatchIndex = [];
    this.disableBrowserSpellcheck();
    if (!this.state.settings.strictSpellcheck) return;

    const protectedLexicon = this.buildProtectedLexicon();
    const active = this.getCaretSnapshot();
    const tokenLookup = this.getEffectiveTypoLookup();
    const phraseRules = this.getEffectiveTypoPhraseRules();
    const typoRanges = [];
    const smartRanges = [];
    document.querySelectorAll('.page-content p, .page-content blockquote, .page-content h2').forEach((block) => {
      const { textNodes, fullText } = this.textNodesForHighlightBlock(block);
      if (!fullText.trim()) return;
      const occupied = [];
      const fragmentBase = Number(block.dataset.fragmentStart || 0);
      const editable = block.closest('.page-content');
      const paneId = editable?.dataset.paneId || block.closest('.workspace-pane')?.dataset.paneId || 'primary';
      const docId = editable?.dataset.docId || null;

      phraseRules.forEach((rule) => {
        const pattern = this.escapeRegExp(rule.wrong).replace(/\s+/g, '\\s+');
        const regex = new RegExp(`(^|[^\\p{L}\\p{N}_])(${pattern})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
        let phraseMatch = regex.exec(fullText);
        while (phraseMatch) {
          const start = phraseMatch.index + phraseMatch[1].length;
          const end = start + phraseMatch[2].length;
          if (
            !this.typoRangeOverlaps(occupied, start, end)
            && this.isCompletedTypoToken(fullText, start, end, active, block.dataset.blockId)
            && !this.isProtectedTypoPhrase(phraseMatch[2], protectedLexicon)
          ) {
            const range = this.rangeFromBlockOffsets(textNodes, start, end);
            if (range) {
              typoRanges.push(range);
              this.registerTypoMatch({ docId, paneId, blockId: block.dataset.sourceBlockId || block.dataset.blockId, start: fragmentBase + start, end: fragmentBase + end, rawText: phraseMatch[2], rule, source: 'exact' });
              occupied.push([start, end]);
            }
          }
          phraseMatch = regex.exec(fullText);
        }
      });

      const tokenRegex = /\p{L}+(?:[’'\-]\p{L}+)*/gu;
      let match = tokenRegex.exec(fullText);
      while (match) {
        const rawWord = match[0];
        const start = match.index;
        const end = start + rawWord.length;
        const normalized = normalizeTypoToken(rawWord);
        const typo = tokenLookup[normalized];
        if (
          typo
          && !protectedLexicon.has(normalized)
          && !this.typoRangeOverlaps(occupied, start, end)
          && this.isCompletedTypoToken(fullText, start, end, active, block.dataset.blockId)
        ) {
          const range = this.rangeFromBlockOffsets(textNodes, start, end);
          if (range) {
            typoRanges.push(range);
            this.registerTypoMatch({ docId, paneId, blockId: block.dataset.sourceBlockId || block.dataset.blockId, start: fragmentBase + start, end: fragmentBase + end, rawText: rawWord, rule: typo, source: 'exact' });
            occupied.push([start, end]);
          }
        }
        match = tokenRegex.exec(fullText);
      }
      if (this.state.settings.smartDictionary) {
        this.collectSmartTypoMatches({ block, textNodes, fullText, occupied, protectedLexicon, tokenLookup, active, docId, paneId, fragmentBase, smartRanges });
      }
    });
    if (typoRanges.length) CSS.highlights.set('typo-errors', new Highlight(...typoRanges));
    if (smartRanges.length) CSS.highlights.set('typo-smart-errors', new Highlight(...smartRanges));
  }

  scheduleSpellerCheck() {
    if (this.spellerTimer) return;
    this.spellerTimer = setTimeout(async () => {
      this.spellerTimer = null;
      if (!this.spellerQueue || !this.spellerQueue.size) return;
      
      const words = Array.from(this.spellerQueue).slice(0, 50);
      words.forEach(w => {
        this.spellerQueue.delete(w);
        this.spellerPending.add(w);
      });
      
      try {
        const url = 'https://speller.yandex.net/services/spellcheck?options=518';
        const formData = new URLSearchParams();
        words.forEach(w => formData.append('text', w));
        
        const res = await fetch(url, {
          method: 'POST',
          body: formData
        });
        
        if (res.ok) {
          const data = await res.json();
          const errorMap = new Map();
          data.forEach(item => {
            if (item.word && item.s && item.s.length) {
              errorMap.set(item.word.toLowerCase(), item.s[0]);
            }
          });
          
          words.forEach(w => {
            this.spellerPending.delete(w);
            if (errorMap.has(w)) {
              this.spellerCache.set(w, {
                correct: errorMap.get(w),
                label: 'Smart-словарь: опечатка'
              });
            } else {
              this.spellerCache.set(w, null);
            }
          });
          
          this.updateTypoHighlightsDebounced();
        } else {
          words.forEach(w => this.spellerPending.delete(w));
        }
      } catch (e) {
        console.error('Speller API error:', e);
        words.forEach(w => this.spellerPending.delete(w));
      }
    }, 600);
  }

  registerTypoMatch({ docId, paneId, blockId, start, end, rawText, rule, source = 'exact', smartConfidence = null }) {
    if (!docId || !blockId || !rule?.correct) return;
    this.typoMatchIndex.push({
      id: uid('typo-match'),
      docId,
      paneId,
      blockId,
      startOffset: start,
      endOffset: end,
      rawText,
      normalizedText: normalizeTypoToken(rawText),
      ruleId: rule.id,
      builtinKey: rule.builtinKey,
      correct: rule.correct,
      label: rule.label || 'Частая ошибка',
      source,
      smartConfidence,
    });
  }



  collectSmartTypoMatches({ block, textNodes, fullText, occupied, protectedLexicon, tokenLookup, active, docId, paneId, fragmentBase = 0, smartRanges }) {
    this.spellerCache = this.spellerCache || new Map();
    this.spellerQueue = this.spellerQueue || new Set();
    this.spellerPending = this.spellerPending || new Set();
    
    const tokenRegex = /\p{L}+(?:[’'\-]\p{L}+)*/gu;
    let match = tokenRegex.exec(fullText);
    const wordsToQueue = [];
    
    while (match) {
      const rawWord = match[0];
      const start = match.index;
      const end = start + rawWord.length;
      const normalized = normalizeTypoToken(rawWord);
      
      if (
        normalized.length >= 3
        && !protectedLexicon.has(normalized)
        && !tokenLookup[normalized]
        && !this.typoRangeOverlaps(occupied, start, end)
        && this.isCompletedTypoToken(fullText, start, end, active, block.dataset.blockId)
      ) {
        if (this.spellerCache.has(normalized)) {
          const cachedTypo = this.spellerCache.get(normalized);
          if (cachedTypo) {
            const range = this.rangeFromBlockOffsets(textNodes, start, end);
            if (range) {
              smartRanges.push(range);
              occupied.push([start, end]);
              this.registerTypoMatch({
                docId,
                paneId,
                blockId: block.dataset.sourceBlockId || block.dataset.blockId,
                start: fragmentBase + start,
                end: fragmentBase + end,
                rawText: rawWord,
                rule: {
                  id: `smart-${normalized}`,
                  wrong: rawWord,
                  correct: cachedTypo.correct,
                  label: cachedTypo.label,
                  builtinKey: normalized
                },
                source: 'smart'
              });
            }
          }
        } else {
          if (!this.spellerQueue.has(normalized) && !this.spellerPending.has(normalized)) {
            wordsToQueue.push(normalized);
          }
        }
      }
      match = tokenRegex.exec(fullText);
    }
    
    if (wordsToQueue.length) {
      wordsToQueue.forEach(w => this.spellerQueue.add(w));
      this.scheduleSpellerCheck();
    }
  }

  findSmartTypoCandidate(normalized, rules) {
    let best = null;
    rules.forEach((rule) => {
      const wrong = rule.normalizedWrong || normalizeTypoToken(rule.wrong);
      if (!wrong || Math.abs(wrong.length - normalized.length) > 2 || wrong.length < 5) return;
      const maxDistance = wrong.length >= 9 ? 2 : 1;
      const distance = this.boundedLevenshtein(normalized, wrong, maxDistance);
      if (distance < 0) return;
      const score = distance + (rule.source === 'builtin' ? 0 : .12);
      if (!best || score < best.score) best = { rule, distance, score, confidence: Math.max(.55, 1 - distance / Math.max(wrong.length, normalized.length)) };
    });
    return best;
  }

  boundedLevenshtein(a = '', b = '', maxDistance = 1) {
    if (Math.abs(a.length - b.length) > maxDistance) return -1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      let rowMin = row[0];
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const value = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        row[j] = value;
        rowMin = Math.min(rowMin, value);
      }
      if (rowMin > maxDistance) return -1;
      prev = row;
    }
    return prev[b.length] <= maxDistance ? prev[b.length] : -1;
  }

  buildEffectiveTypoRules() {
    const effective = new Map();
    Object.entries(TYPO_LOOKUP).forEach(([key, value]) => {
      effective.set(key, {
        id: `builtin-${key}`,
        wrong: value.wrong || key,
        normalizedWrong: key,
        correct: value.correct || '',
        label: value.label || 'Частая ошибка',
        enabled: true,
        source: 'builtin',
        matchMode: /\s/u.test(value.wrong || key) ? 'phrase' : 'token',
        builtinKey: key,
      });
    });
    this.state.typoRules.forEach((rule) => {
      const clean = this.sanitizeTypoRule(rule);
      if (!clean) return;
      const builtinKey = clean.builtinKey || clean.normalizedWrong;
      if (clean.source === 'disabled-builtin') {
        effective.delete(builtinKey);
        return;
      }
      if (clean.enabled === false) return;
      effective.set(clean.normalizedWrong, clean);
    });
    return [...effective.values()].filter((rule) => rule.enabled !== false && rule.source !== 'disabled-builtin');
  }

  getEffectiveTypoLookup() {
    return this.buildEffectiveTypoRules().reduce((lookup, rule) => {
      if (rule.matchMode !== 'phrase') lookup[rule.normalizedWrong] = rule;
      return lookup;
    }, {});
  }

  getEffectiveTypoPhraseRules() {
    return this.buildEffectiveTypoRules()
      .filter((rule) => rule.matchMode === 'phrase')
      .sort((a, b) => b.wrong.length - a.wrong.length);
  }

  typoRangeOverlaps(ranges, start, end) {
    return ranges.some(([from, to]) => start < to && end > from);
  }

  isProtectedTypoPhrase(value, protectedLexicon) {
    const words = String(value || '').match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [];
    return words.length > 0 && words.every((word) => protectedLexicon.has(normalizeTypoToken(word)));
  }

  textNodesForHighlightBlock(block) {
    const textNodes = [];
    let fullText = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      // Accept all non-null text nodes (including space-only) so offset tracking stays accurate
      acceptNode: (node) => (node.nodeValue != null) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    let node = walker.nextNode();
    while (node) {
      const text = cleanAnalysisResidue(node.nodeValue || '');
      textNodes.push({ node, start: fullText.length, end: fullText.length + text.length });
      fullText += text;
      node = walker.nextNode();
    }
    return { textNodes, fullText };
  }

  isCompletedTypoToken(text, start, end, active, blockId) {
    const caretInsideToken = active?.blockId === blockId && active.offset >= start && active.offset <= end;
    if (caretInsideToken) return false;
    if (end >= text.length) return !caretInsideToken;
    return /[\s.,!?;:()\[\]{}"'\u00ab\u00bb\u201c\u201d\u2018\u2019\u2014\u2013-]/u.test(text[end] || '');
  }

  buildProtectedLexicon() {
    const protectedWords = new Set();
    const addText = (value) => {
      if (!value) return;
      const matches = String(value).match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [];
      matches.forEach((word) => protectedWords.add(normalizeTypoToken(word)));
    };
    this.allEntities().forEach((entity) => {
      [
        entity.name,
        entity.firstName,
        entity.lastName,
        entity.displayName,
        ...(entity.aliases || []),
        ...(entity.mentionForms || []),
      ].forEach(addText);
    });
    return protectedWords;
  }

  rangeFromBlockOffsets(textNodes, start, end) {
    const startPart = textNodes.find((part) => start >= part.start && start < part.end)
      || textNodes.find((part) => start === part.end);
    const endPart = textNodes.find((part) => end > part.start && end <= part.end)
      || textNodes.find((part) => end === part.start);
    if (!startPart || !endPart) return null;
    const range = new Range();
    range.setStart(startPart.node, Math.max(0, start - startPart.start));
    range.setEnd(endPart.node, Math.max(0, end - endPart.start));
    return range;
  }

  serializeRangeToReviewAnchor(range, docId) {
    if (!range || !docId) return null;
    const startBlock = (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.closest?.('[data-block-id]');
    const endBlock = (range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement)?.closest?.('[data-block-id]');
    if (!startBlock || !endBlock || startBlock.dataset.blockId !== endBlock.dataset.blockId) {
      this.toast('Пока можно комментировать выделение внутри одного блока.');
      return null;
    }
    const startPre = range.cloneRange();
    startPre.selectNodeContents(startBlock);
    startPre.setEnd(range.startContainer, range.startOffset);
    const endPre = range.cloneRange();
    endPre.selectNodeContents(endBlock);
    endPre.setEnd(range.endContainer, range.endOffset);
    const text = startBlock.textContent || '';
    const start = startPre.toString().length;
    const end = endPre.toString().length;
    return {
      start: { blockId: startBlock.dataset.blockId, offset: start },
      end: { blockId: endBlock.dataset.blockId, offset: end },
      quote: range.toString(),
      prefix: text.slice(Math.max(0, start - 36), start),
      suffix: text.slice(end, end + 36),
    };
  }

  resolveReviewRange(mark) {
    const scopes = [...document.querySelectorAll(`.page-content[data-doc-id="${mark.docId}"]`)];
    for (const scope of scopes) {
      const candidates = [...scope.querySelectorAll(`[data-block-id="${CSS.escape(mark.start.blockId)}"], [data-source-block-id="${CSS.escape(mark.start.blockId)}"]`)];
      for (const block of candidates) {
      const { textNodes, fullText } = this.textNodesForHighlightBlock(block);
      let start = Number(mark.start.offset);
      let end = Number(mark.end.offset);
      const fragmentStart = Number(block.dataset.fragmentStart || 0);
      const fragmentEnd = Number(block.dataset.fragmentEnd || 0);
      if (block.dataset.sourceBlockId) {
        if (end < fragmentStart || start > fragmentEnd) continue;
        start -= fragmentStart;
        end -= fragmentStart;
      }
      if (!fullText.slice(start, end) || (mark.quote && fullText.slice(start, end) !== mark.quote)) {
        const found = mark.quote ? this.findBestQuoteOffset(fullText, mark.quote, mark.prefix, mark.suffix, Number(mark.start.offset || 0)) : -1;
        if (found >= 0) {
          start = found;
          end = found + mark.quote.length;
        }
      }
      const range = this.rangeFromBlockOffsets(textNodes, start, end);
      if (range) return { range, block, start, end };
      }
    }
    return null;
  }

  findBestQuoteOffset(text, quote, prefix = '', suffix = '', oldOffset = 0) {
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

  async createReviewMarkFromSelection(kind, category = 'style', options = {}) {
    const ctx = this.state.contextMenu;
    const range = this.restoreContextRange();
    const docId = ctx?.docId || this.getFocusedDoc()?.id;
    const anchor = this.serializeRangeToReviewAnchor(range, docId);
    if (!anchor || !anchor.quote.trim()) return null;
    if (kind === 'issue') {
      const existing = this.state.reviewMarks.find((mark) => (
        mark.kind === 'issue'
        && mark.status === 'open'
        && mark.docId === docId
        && mark.category === category
        && mark.start?.blockId === anchor.start.blockId
        && mark.end?.blockId === anchor.end.blockId
        && Math.abs(Number(mark.start?.offset || 0) - Number(anchor.start.offset || 0)) <= 1
        && Math.abs(Number(mark.end?.offset || 0) - Number(anchor.end.offset || 0)) <= 1
        && (mark.quote || '').trim() === anchor.quote.trim()
      ));
      if (existing) {
        await this.deleteReviewMark(existing.id);
        this.closeContextMenu();
        this.toast('Проблема снята.');
        return null;
      }
    }
    const mark = await this.saveReviewMark({
      id: uid('review'),
      docId,
      kind,
      category,
      colorKey: category,
      ...anchor,
      comment: options.comment || '',
      suggestion: options.suggestion || '',
      status: 'open',
      createdAt: Date.now(),
    });
    this.closeContextMenu();
    this.toast(kind === 'suggestion' ? 'Замена добавлена.' : kind === 'issue' ? 'Проблема помечена.' : 'Комментарий добавлен.');
    return mark;
  }

  openReviewCommentForm() {
    this.closeContextMenu();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal review-form-modal">
        <h2>Добавить комментарий</h2>
        <div class="review-form-stack">
          <label class="form-field"><span>Категория</span><select class="modal-select" id="review-category">
            <option value="style">Стиль / ритм</option><option value="logic">Логика</option><option value="plot">Сюжет / мотивация</option><option value="continuity">Лор / непрерывность</option><option value="orthography">Орфография</option>
          </select></label>
          <label class="form-field"><span>Комментарий</span><textarea class="form-control" id="review-comment" rows="6"></textarea></label>
        </div>
        <div class="form-actions"><button class="pill-btn" data-close-form>Отмена</button><button class="pill-btn ai-btn" id="save-review-comment">Сохранить</button></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('#save-review-comment').onclick = async () => {
      await this.createReviewMarkFromSelection('comment', overlay.querySelector('#review-category').value, { comment: overlay.querySelector('#review-comment').value.trim() });
      overlay.classList.remove('active');
    };
  }

  openReviewSuggestionForm() {
    const ctx = this.state.contextMenu;
    const selectedText = ctx?.selectedText || getSelection()?.toString()?.trim() || '';
    this.closeContextMenu();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal review-form-modal">
        <h2>Предложить замену</h2>
        <div class="review-form-stack">
          <label class="form-field"><span>Исходный текст</span><div class="review-quote-preview">${escapeHtml(selectedText)}</div></label>
          <label class="form-field"><span>Предлагаемая замена</span><textarea class="form-control" id="review-suggestion" rows="5"></textarea></label>
          <label class="form-field"><span>Комментарий</span><textarea class="form-control" id="review-comment" rows="3"></textarea></label>
        </div>
        <div class="form-actions"><button class="pill-btn" data-close-form>Отмена</button><button class="pill-btn ai-btn" id="save-review-suggestion">Сохранить</button></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('#save-review-suggestion').onclick = async () => {
      await this.createReviewMarkFromSelection('suggestion', 'style', { suggestion: overlay.querySelector('#review-suggestion').value, comment: overlay.querySelector('#review-comment').value.trim() });
      overlay.classList.remove('active');
    };
  }

  updateReviewHighlights() {
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    ['orthography', 'punctuation', 'grammar', 'style', 'repetition', 'lore', 'continuity', 'logic', 'plot', 'current'].forEach((key) => CSS.highlights.delete(`review-${key}`));
    if (this.state.reviewMode === 'write') return;
    const rangesByCategory = { orthography: [], punctuation: [], grammar: [], style: [], repetition: [], lore: [], continuity: [], logic: [], plot: [], current: [] };
    this.state.reviewMarks.filter((mark) => mark.status === 'open').forEach((mark) => {
      const resolved = this.resolveReviewRange(mark);
      if (!resolved) return;
      rangesByCategory[mark.category || 'style'].push(resolved.range);
      if (mark.id === this.state.activeReviewMarkId) rangesByCategory.current.push(resolved.range.cloneRange());
    });
    Object.entries(rangesByCategory).forEach(([key, ranges]) => {
      if (ranges.length) CSS.highlights.set(`review-${key}`, new Highlight(...ranges));
    });
  }

  reviewMarksForFocusedDoc() {
    const doc = this.getFocusedDoc();
    if (!doc) return [];
    const order = new Map((doc.ast?.blocks || []).map((block, index) => [block.id, index]));
    return this.state.reviewMarks
      .filter((mark) => mark.docId === doc.id && mark.status === 'open')
      .sort((a, b) => (order.get(a.start?.blockId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.start?.blockId) ?? Number.MAX_SAFE_INTEGER) || (a.start?.offset || 0) - (b.start?.offset || 0));
  }

  hasFocusedTextSelection() {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed || !String(sel.toString()).trim()) return false;
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const editable = node?.closest?.('.page-content');
    return !!editable && editable.dataset.docId === this.getFocusedDoc()?.id;
  }

  renderReviewToolbarSlot() {
    const slot = document.getElementById('review-toolbar-slot');
    if (!slot) return;
    const mode = this.state.reviewMode || 'write';
    if (mode === 'write') {
      slot.innerHTML = '';
      slot.className = 'review-toolbar-slot empty';
      return;
    }
    if (mode === 'editor') {
      const enabled = this.hasFocusedTextSelection();
      const disabled = enabled ? '' : 'disabled';
      slot.className = 'review-toolbar-slot editor-tools';
      slot.innerHTML = `
        <button class="review-tool-btn icon-only" data-action="quick-review-comment" title="${enabled ? 'Комментарий' : 'Комментарий — выделите текст'}" aria-label="Комментарий" ${disabled}><i class="bx bx-comment-detail"></i></button>
        <button class="review-tool-btn icon-only" data-action="quick-review-suggestion" title="${enabled ? 'Замена' : 'Замена — выделите текст'}" aria-label="Замена" ${disabled}><i class="bx bx-transfer-alt"></i></button>
        <div class="review-issue-dropdown">
          <button class="review-tool-btn icon-only has-chevron" data-action="toggle-review-issue-menu" title="${enabled ? 'Проблема' : 'Проблема — выделите текст'}" aria-label="Проблема" ${disabled}><i class="bx bx-error-circle"></i><i class="bx bx-chevron-down review-chevron"></i></button>
        </div>
        <button class="review-tool-btn icon-only" data-action="quick-typo-rule" title="${enabled ? 'В словарь' : 'В словарь — выделите текст'}" aria-label="В словарь" ${disabled}><i class="bx bx-book-add"></i></button>
      `;
      return;
    }
    const marks = this.reviewMarksForFocusedDoc();
    const docId = this.getFocusedDoc()?.id;
    const index = Math.min(marks.length - 1, Math.max(0, this.state.currentReviewIndexByDoc[docId] || 0));
    slot.className = 'review-toolbar-slot finalization-tools';
    slot.innerHTML = marks.length
      ? `<div class="review-toolbar-nav"><button class="review-tool-btn icon-only" data-action="review-prev" title="Предыдущая правка" aria-label="Предыдущая правка"><i class="bx bx-chevron-left"></i></button><span class="review-count">${index + 1} / ${marks.length}</span><button class="review-tool-btn icon-only" data-action="review-next" title="Следующая правка" aria-label="Следующая правка"><i class="bx bx-chevron-right"></i></button></div>`
      : '<span class="review-empty-chip"><i class="bx bx-check-circle"></i>Правок нет</span>';
  }

  renderReviewNavigator() {
    const nav = document.getElementById('review-navigator');
    if (!nav) return;
    const marks = this.reviewMarksForFocusedDoc();
    if (this.state.reviewMode !== 'finalization') {
      nav.classList.remove('active');
      nav.setAttribute('aria-hidden', 'true');
      nav.innerHTML = '';
      return;
    }
    if (!marks.length) {
      nav.innerHTML = '';
      nav.classList.remove('active', 'empty');
      nav.setAttribute('aria-hidden', 'true');
      return;
    }
    const docId = this.getFocusedDoc()?.id;
    const index = Math.min(marks.length - 1, Math.max(0, this.state.currentReviewIndexByDoc[docId] || 0));
    const mark = marks[index];
    this.state.activeReviewMarkId = mark.id;
    nav.innerHTML = `
      <div class="review-nav-controls">
        <button data-action="review-prev"><i class="bx bx-chevron-left"></i></button>
        <span>${index + 1} / ${marks.length}</span>
        <button data-action="review-next"><i class="bx bx-chevron-right"></i></button>
      </div>
      <div class="review-detail-card">
        <div><span class="review-chip ${mark.category}">${this.reviewCategoryLabel(mark.category)}</span><span class="review-chip">${this.reviewKindLabel(mark.kind)}</span>${mark.source === 'ai' ? '<span class="review-chip">AI</span>' : ''}</div>
        ${mark.unresolvedRange ? '<p class="review-unresolved">Не удалось привязать к тексту.</p>' : ''}
        <blockquote>${escapeHtml(mark.quote)}</blockquote>
        ${mark.comment ? `<p>${escapeHtml(mark.comment)}</p>` : ''}
        ${mark.suggestion ? `<div class="review-suggestion-text">${escapeHtml(mark.suggestion)}</div>` : ''}
        <div class="review-detail-actions">
          ${mark.kind === 'suggestion' ? '<button class="pill-btn ai-btn" data-action="review-accept">Принять</button><button class="pill-btn" data-action="review-reject">Отклонить</button>' : '<button class="pill-btn ai-btn" data-action="review-resolve">Решено</button>'}
        </div>
      </div>`;
    nav.classList.remove('empty');
    nav.classList.add('active');
    nav.setAttribute('aria-hidden', 'false');
    this.updateReviewHighlights();
  }

  hideReviewNavigatorIfNoMarks() {
    if (this.reviewMarksForFocusedDoc().length) return;
    const nav = document.getElementById('review-navigator');
    if (!nav) return;
    nav.innerHTML = '';
    nav.classList.remove('active', 'empty');
    nav.setAttribute('aria-hidden', 'true');
    this.state.activeReviewMarkId = null;
    this.updateReviewHighlights();
  }

  reviewCategoryLabel(category) {
    return { orthography: 'Орфография', punctuation: 'Пунктуация', grammar: 'Грамматика', repetition: 'Повтор', lore: 'Лор', logic: 'Логика', plot: 'Сюжет', continuity: 'Непрерывность', style: 'Стиль' }[category] || 'Стиль';
  }

  reviewKindLabel(kind) {
    return { comment: 'Комментарий', issue: 'Пометка', suggestion: 'Замена' }[kind] || 'Пометка';
  }

  handleReviewAction(action) {
    if (!['review-prev', 'review-next', 'review-accept', 'review-reject', 'review-resolve'].includes(action)) return false;
    if (action === 'review-prev') this.moveReviewNavigator(-1);
    if (action === 'review-next') this.moveReviewNavigator(1);
    if (['review-accept', 'review-reject', 'review-resolve'].includes(action)) this.finishCurrentReviewMark(action);
    return true;
  }

  handleReviewToolbarAction(action, event) {
    if (!['quick-review-comment', 'quick-review-suggestion', 'quick-review-issue', 'quick-typo-rule', 'toggle-review-issue-menu'].includes(action)) return false;
    const button = event.target.closest('[data-action]');
    if (button?.disabled) return true;
    if (action === 'toggle-review-issue-menu') {
      const menu = document.getElementById('review-issue-menu');
      const willOpen = !menu?.classList.contains('open');
      if (willOpen) this.openFloatingMenu('review');
      else this.closeFloatingMenu('review');
      return true;
    }
    const snapshot = this.reviewToolbarSelectionSnapshot || this.selectionSnapshot;
    if (snapshot) this.restoreSelectionSnapshot(snapshot);
    if (!this.hasFocusedTextSelection()) return true;
    this.contextSelectionRange = getSelection().getRangeAt(0).cloneRange();
    if (action === 'quick-review-comment') this.openReviewCommentForm();
    if (action === 'quick-review-suggestion') this.openReviewSuggestionForm();
    if (action === 'quick-review-issue') this.createReviewMarkFromSelection('issue', button?.dataset.reviewCategory || 'style');
    if (action === 'quick-typo-rule') this.openTypoRuleForm(getSelection().toString());
    this.closeFloatingMenu('review');
    return true;
  }

  moveReviewNavigator(delta) {
    const doc = this.getFocusedDoc();
    const marks = this.reviewMarksForFocusedDoc();
    if (!doc || !marks.length) return;
    const next = (Math.max(0, this.state.currentReviewIndexByDoc[doc.id] || 0) + delta + marks.length) % marks.length;
    this.state.currentReviewIndexByDoc[doc.id] = next;
    const resolved = this.resolveReviewRange(marks[next]);
    resolved?.block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.renderReviewNavigator();
  }

  async finishCurrentReviewMark(action) {
    const marks = this.reviewMarksForFocusedDoc();
    const doc = this.getFocusedDoc();
    if (!doc || !marks.length) return;
    const mark = marks[Math.min(marks.length - 1, this.state.currentReviewIndexByDoc[doc.id] || 0)];
    if (action === 'review-accept' && mark.kind === 'suggestion') {
      const resolved = this.resolveReviewRange(mark);
      if (!resolved) {
        mark.unresolvedRange = true;
        await this.saveReviewMark(mark);
        this.toast('Не удалось применить замену: исходный фрагмент больше не найден.');
        return;
      }
      const range = resolved.range;
      const editable = resolved.block.closest('.page-content');
      range.deleteContents();
      range.insertNode(document.createTextNode(mark.suggestion || ''));
      if (editable) this.editorInput(editable, { inputType: 'insertReplacementText' });
      mark.status = 'accepted';
    } else if (action === 'review-reject') {
      mark.status = 'rejected';
    } else {
      mark.status = 'resolved';
    }
    await this.saveReviewMark(mark);
  }

  decorateWriterSyntax(html) {
    return html
      .replace(/(«[^»]+»|"[^"]+")/g, '<span class="syntax-dialogue">$1</span>')
      .replace(/(\([^)]{3,}\))/g, '<span class="syntax-thought">$1</span>');
  }

  decorateWeakWords(html) {
    const words = ['очень', 'сильно', 'быстро', 'внезапно', 'просто', 'как будто', 'словно бы', 'являлся', 'был сделан'];
    let result = html;
    words.forEach((word) => {
      result = result.replace(new RegExp(`\\b(${this.escapeRegExp(word)})\\b`, 'giu'), '<span class="weak-word">$1</span>');
    });
    return result;
  }

  decorateEntities(html) {
    const index = this.buildEntityMentionIndex();
    if (!index.length) return html;
    const root = document.createElement('div');
    root.innerHTML = html;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      if (!node.parentElement?.closest?.('.entity-link')) nodes.push(node);
      node = walker.nextNode();
    }
    nodes.forEach((textNode) => {
      const fragment = this.entityDecoratedFragment(textNode.nodeValue || '', index);
      if (fragment) textNode.replaceWith(fragment);
    });
    return root.innerHTML;
  }

  entityDecoratedFragment(text, index) {
    const matches = this.findEntityMatches(text, index);
    if (!matches.length) return null;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    matches.forEach((match) => {
      if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const span = document.createElement('span');
      span.className = match.type === 'family-group' ? 'entity-link entity-family-link' : 'entity-link';
      span.tabIndex = 0;
      span.textContent = text.slice(match.start, match.end);
      if (match.type === 'family-group') {
        span.dataset.entityKind = 'family';
        span.dataset.familyName = match.familyName;
        span.dataset.entityLabel = `Семья ${match.familyName}`;
        span.setAttribute('aria-label', `Семья ${match.familyName}`);
      } else {
        span.dataset.entityKind = match.kind;
        span.dataset.entityId = match.entity.id;
        span.dataset.entityLabel = this.entityDisplayName(match.entity);
        span.setAttribute('aria-label', this.entityDisplayName(match.entity));
      }
      fragment.appendChild(span);
      cursor = match.end;
    });
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    return fragment;
  }

  findEntityMatches(text, index) {
    const normalizedText = normalizeTypoToken(text);
    const matches = [];
    let pos = 0;
    while (pos < text.length) {
      const entry = index.find((candidate) => (
        normalizedText.startsWith(candidate.normalized, pos)
        && this.isEntityBoundary(text[pos - 1])
        && this.isEntityBoundary(text[pos + candidate.mention.length])
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

  isEntityBoundary(char) {
    return !char || !/[\p{L}\p{N}_]/u.test(char);
  }

  buildEntityMentionIndex() {
    const entries = [];
    const push = (mention, payload) => {
      const clean = String(mention || '').trim();
      if (!clean) return;
      entries.push({ mention: clean, normalized: normalizeTypoToken(clean), ...payload });
    };
    const characters = this.state.lore.characters || [];
    const familyMap = new Map();
    characters.forEach((character) => {
      const lastName = (character.lastName || '').trim();
      if (!lastName) return;
      const key = normalizeTypoToken(lastName);
      familyMap.set(key, [...(familyMap.get(key) || []), character]);
    });
    characters.forEach((character) => {
      this.entityMentionValues(character).forEach((mention) => {
        const familyMembers = familyMap.get(normalizeTypoToken(character.lastName || '')) || [];
        const isSharedSurname = familyMembers.length > 1 && normalizeTypoToken(mention) === normalizeTypoToken(character.lastName || '');
        if (isSharedSurname) return;
        push(mention, {
          type: 'exact-entity',
          kind: 'character',
          entity: character,
        });
      });
    });
    familyMap.forEach((members, key) => {
      const familyName = members[0]?.lastName || '';
      if (members.length > 1) {
        push(familyName, { type: 'family-group', kind: 'family', familyName, members });
      } else if (members[0]) {
        push(familyName, {
          type: 'single-entity-surname',
          kind: 'character',
          entity: members[0],
        });
      }
    });
    (this.state.lore.locations || []).forEach((location) => {
      this.entityMentionValues(location).forEach((mention) => push(mention, {
        type: 'location',
        kind: 'location',
        entity: location,
      }));
    });
    const seen = new Set();
    return entries
      .filter((entry) => {
        const key = `${entry.normalized}:${entry.type}:${entry.entity?.id || entry.familyName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.mention.length - a.mention.length);
  }

  entityMentionValues(entity) {
    return [...new Set([
      entity.displayName,
      entity.name,
      entity.firstName,
      ...(entity.aliases || []),
      ...(entity.mentionForms || []),
    ].map((value) => String(value || '').trim()).filter(Boolean))];
  }

  entityDisplayName(entity = {}) {
    return entity.displayName || entity.name || entity.title || '';
  }

  escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  allEntities() {
    return [...this.state.lore.characters, ...this.state.lore.locations];
  }

  getCombinedHtmlForBlock(sourceBlockId) {
    const nodes = [...document.querySelectorAll(`[data-block-id="${CSS.escape(sourceBlockId)}"], [data-source-block-id="${CSS.escape(sourceBlockId)}"]`)];
    const cleanedHtmls = nodes.map((node) => {
      const clone = node.cloneNode(true);
      stripAnalysisMarkup(clone);
      return clone.innerHTML;
    });
    return cleanedHtmls.join('');
  }

  handleRichEditorChange(paneId, doc, transaction = null) {
    if (!doc || doc.locked || this.isComposing) return;
    if (this.state.workspace?.focusedPaneId !== paneId) this.setFocusedPane(paneId);
    if (this.state.suggestion?.docId === doc.id) {
      this.clearSuggestion();
      this.toast('AI-РїСЂРµРґР»РѕР¶РµРЅРёРµ РѕС‚РјРµРЅРµРЅРѕ: РґРѕРєСѓРјРµРЅС‚ Р±С‹Р» РёР·РјРµРЅС‘РЅ.');
      this.renderWorkspacePane(paneId);
      return;
    }

    this.bumpDocRenderRevision(doc);
    doc.summary = doc.description || buildSummary(doc.ast);
    doc.updatedAt = Date.now();
    this.updateActiveBlock();
    this.renderGoal();
    this.writeLiveDraft(doc.id);
    this.saveDocByIdDebounced(doc.id);
    this.scheduleSyncForDoc(doc.id, { inputType: transaction?.getMeta?.('uiEvent') || 'prosemirrorTransaction' });
    if (this.searchSession?.docId === doc.id) this.searchRefreshDebounced();
    this.nocturneEditor?.scheduleVisualPages(paneId);
  }

  editorInput(editable, inputEvent = null) {
    if (this.nocturneEditor?.getByElement(editable)) return;
    if (this.isComposing) return;
    const paneId = editable.dataset.paneId || this.state.workspace?.focusedPaneId || 'primary';
    const doc = this.getDocForPane(paneId);
    if (!doc || doc.locked) return;

    if (this.state.workspace?.focusedPaneId !== paneId) this.setFocusedPane(paneId);
    if (this.state.suggestion?.docId === doc.id) {
      this.clearSuggestion();
      this.toast('AI-предложение отменено: документ был изменён.');
      this.renderWorkspacePane(paneId);
      return;
    }

    const container = document.querySelector(`[data-editor-container][data-pane-id="${paneId}"]`);
    if (!container) return;

    // Parse blocks from all page-content editables inside the editor container
    const editables = [...container.querySelectorAll('.page-content')];
    const rawBlocks = editables.flatMap(el => parseBlocksFromEditable(el));
    
    // Merge consecutive fragments sharing the same ID
    const mergedBlocks = [];
    rawBlocks.forEach((block) => {
      const prev = mergedBlocks.at(-1);
      if (prev && prev.id === block.id) {
        prev.html = (prev.html === '<br>' ? '' : prev.html) + (block.html === '<br>' ? '' : block.html);
        if (!prev.html) prev.html = '<br>';
      } else {
        mergedBlocks.push({ ...block });
      }
    });

    doc.ast.blocks = mergedBlocks;
    
    const revision = this.bumpDocRenderRevision(doc);
    doc.summary = doc.description || buildSummary(doc.ast);
    doc.updatedAt = Date.now();
    this.updateActiveBlock();
    
    this.renderGoal();
    this.writeLiveDraft(doc.id);
    this.saveDocByIdDebounced(doc.id);
    this.scheduleSyncForDoc(doc.id, inputEvent);
    
    if (this.shouldRefreshReadability(inputEvent)) {
      this.updateReadabilityDebounced();
    } else {
      this.updateReadabilityForTyping(inputEvent);
    }
    if (this.shouldRefreshTypoHighlights(inputEvent)) this.updateTypoHighlightsDebounced();
    this.scheduleLiveEntityRefresh(editable, inputEvent);
    if (this.searchSession?.docId === doc.id) this.searchRefreshDebounced();

    // Verify page splits immediately on overflow, Enter, or Paste, otherwise debounce
    const overflowed = editable.scrollHeight > editable.clientHeight - 2;
    const isEnter = inputEvent && (inputEvent.inputType === 'insertLineBreak' || inputEvent.inputType === 'insertParagraph');
    const isPaste = inputEvent && inputEvent.inputType === 'insertFromPaste';
    const immediate = overflowed || isEnter || isPaste;
    this.repaginatePreserve(paneId, immediate);
  }

  openSearchChooser() {
    const hasDoc = !!this.getFocusedDoc();
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal search-choice-modal">
        <div class="modal-head-row">
          <div><h2>Выберите режим поиска</h2><p>Быстрый переход к нужным фрагментам рукописи.</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="search-mode-grid">
          <button class="search-mode-card ${hasDoc ? '' : 'disabled'}" data-action="search-mode-current" ${hasDoc ? '' : 'disabled'}>
            <i class="bx bx-file-find"></i>
            <strong>Поиск в текущем документе</strong>
            <span>Найдите все совпадения в открытой главе и переключайтесь между ними прямо в тексте.</span>
            <small>${hasDoc ? 'Быстрый поиск по активному документу.' : 'Нет открытого документа.'}</small>
          </button>
          <button class="search-mode-card" data-action="search-mode-global">
            <i class="bx bx-search-alt-2"></i>
            <strong>Поиск по всем документам</strong>
            <span>Ищите слова и фразы по всей рукописи, получайте список документов и переходите прямо к нужным фрагментам.</span>
            <small>Глобальный поиск по проекту.</small>
          </button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  openDocumentSearch(seed = {}) {
    const doc = this.getFocusedDoc();
    if (!doc) {
      this.toast('Откройте документ, чтобы использовать поиск.');
      return;
    }
    this.closeAllFloatingMenus();
    this.searchSession = {
      mode: seed.mode || 'document',
      docId: doc.id,
      query: seed.query || this.searchSession?.query || '',
      caseSensitive: !!seed.caseSensitive,
      wholeWords: !!seed.wholeWords,
      matches: [],
      activeIndex: Number.isFinite(seed.activeIndex) ? seed.activeIndex : 0,
      label: seed.label || '',
    };
    this.renderDocumentSearchPanel();
    this.refreshSearchSession({ scroll: !!seed.query });
    setTimeout(() => document.getElementById('doc-search-query')?.focus(), 0);
  }

  renderDocumentSearchPanel() {
    const panel = document.getElementById('doc-search-panel');
    if (!panel || !this.searchSession) return;
    const total = this.searchSession.matches?.length || 0;
    const current = total ? Math.min(total, this.searchSession.activeIndex + 1) : 0;
    panel.innerHTML = `
      <div class="doc-search-panel-row">
        <i class="bx bx-search"></i>
        <input id="doc-search-query" data-doc-search-query value="${escapeHtml(this.searchSession.query || '')}" placeholder="Найти в документе">
        <span class="search-count">${current} / ${total}</span>
        <button class="tool-btn" data-action="search-prev" title="Предыдущее"><i class="bx bx-chevron-left"></i></button>
        <button class="tool-btn" data-action="search-next" title="Следующее"><i class="bx bx-chevron-right"></i></button>
        <button class="tool-btn" data-action="close-doc-search" title="Закрыть"><i class="bx bx-x"></i></button>
      </div>
      <div class="search-options-row">
        <label class="nocturne-check"><input type="checkbox" data-doc-search-case ${this.searchSession.caseSensitive ? 'checked' : ''}><span class="check-mark"></span><span>Учитывать регистр</span></label>
        <label class="nocturne-check"><input type="checkbox" data-doc-search-whole ${this.searchSession.wholeWords ? 'checked' : ''}><span class="check-mark"></span><span>Только целые слова</span></label>
      </div>`;
    panel.classList.add('active');
    panel.setAttribute('aria-hidden', 'false');
  }

  updateDocumentSearchCounts() {
    if (!this.searchSession) return;
    const total = this.searchSession.matches?.length || 0;
    const current = total ? Math.min(total, this.searchSession.activeIndex + 1) : 0;
    const count = document.querySelector('#doc-search-panel .search-count');
    if (count) count.textContent = `${current} / ${total}`;
  }

  closeDocumentSearch() {
    this.clearSearchHighlights();
    this.searchSession = null;
    const panel = document.getElementById('doc-search-panel');
    panel?.classList.remove('active');
    panel?.setAttribute('aria-hidden', 'true');
    const nav = document.getElementById('search-navigator');
    nav?.classList.remove('active');
    nav?.setAttribute('aria-hidden', 'true');
    this.renderReviewNavigator();
  }

  refreshSearchSession(options = {}) {
    if (!this.searchSession) return;
    const doc = this.state.docs.find((item) => item.id === this.searchSession.docId);
    if (!doc) return this.closeDocumentSearch();
    this.searchSession.matches = this.collectDocMatches(doc, this.searchSession.query, this.searchSession);
    if (this.searchSession.activeIndex >= this.searchSession.matches.length) this.searchSession.activeIndex = Math.max(0, this.searchSession.matches.length - 1);
    this.updateDocumentSearchCounts();
    this.applySearchHighlights();
    this.renderSearchNavigator();
    if (options.scroll) this.scrollToActiveSearchHit();
  }

  searchTextMatches(text = '', query = '', options = {}) {
    const needle = String(query || '');
    if (!needle) return [];
    const source = options.caseSensitive ? String(text) : String(text).toLowerCase();
    const target = options.caseSensitive ? needle : needle.toLowerCase();
    const matches = [];
    let index = source.indexOf(target);
    while (index >= 0) {
      const end = index + target.length;
      if (!options.wholeWords || this.isWholeWordMatch(text, index, end)) matches.push({ start: index, end, text: String(text).slice(index, end) });
      index = source.indexOf(target, index + Math.max(1, target.length));
    }
    return matches;
  }

  isWordChar(char = '') {
    return /[\p{L}\p{N}_]/u.test(char);
  }

  isWholeWordMatch(text, start, end) {
    return !this.isWordChar(text[start - 1] || '') && !this.isWordChar(text[end] || '');
  }

  collectDocMatches(doc, query, options = {}) {
    if (!String(query || '').trim()) return [];
    const matches = [];
    if (doc.docType === 'book-chapter') {
      const metaText = [doc.workTitle, doc.volume, doc.chapterNumber, doc.bookStatus].filter(Boolean).join(' ');
      if (metaText) {
        this.searchTextMatches(metaText, query, options).forEach((match) => {
          matches.push({ ...match, docId: doc.id, docTitle: doc.title, blockId: 'meta', blockIndex: -1, query });
        });
      }
    }
    if (!doc?.ast?.blocks?.length) return matches;
    doc.ast.blocks.forEach((block, blockIndex) => {
      const text = blockText(block);
      this.searchTextMatches(text, query, options).forEach((match) => {
        matches.push({ ...match, docId: doc.id, docTitle: doc.title, blockId: block.id, blockIndex, query });
      });
    });
    return matches;
  }

  clearSearchHighlights(root = document) {
    root.querySelectorAll?.('.search-hit,.mention-hit').forEach((span) => {
      span.replaceWith(document.createTextNode(span.textContent || ''));
    });
  }

  applySearchHighlights() {
    this.clearSearchHighlights();
    if (!this.searchSession?.matches?.length) return;
    const byBlock = new Map();
    this.searchSession.matches.forEach((match, index) => {
      const list = byBlock.get(match.blockId) || [];
      list.push({ ...match, index });
      byBlock.set(match.blockId, list);
    });
    document.querySelectorAll(`.page-content[data-doc-id="${CSS.escape(this.searchSession.docId)}"] [data-block-id]`).forEach((block) => {
      const matches = byBlock.get(block.dataset.blockId);
      if (!matches?.length) return;
      const { textNodes } = this.textNodesForHighlightBlock(block);
      [...matches].sort((a, b) => b.start - a.start).forEach((match) => {
        const range = this.rangeFromBlockOffsets(textNodes, match.start, match.end);
        if (!range) return;
        const span = document.createElement('span');
        span.className = `search-hit ${match.index === this.searchSession.activeIndex ? 'active' : ''}`;
        span.dataset.searchHit = String(match.index);
        span.appendChild(range.extractContents());
        range.insertNode(span);
      });
    });
  }

  renderSearchNavigator() {
    const nav = document.getElementById('search-navigator');
    if (!nav || !this.searchSession) return;
    const total = this.searchSession.matches?.length || 0;
    const current = total ? this.searchSession.activeIndex + 1 : 0;
    nav.innerHTML = `
      <button class="btn-icon" data-action="search-prev"><i class="bx bx-chevron-left"></i></button>
      <strong>${total ? `${current} / ${total}` : '0 / 0'}</strong>
      <button class="btn-icon" data-action="search-next"><i class="bx bx-chevron-right"></i></button>`;
    nav.classList.toggle('active', !!this.searchSession.query);
    nav.setAttribute('aria-hidden', this.searchSession.query ? 'false' : 'true');
  }

  moveSearchResult(delta) {
    if (!this.searchSession?.matches?.length) return;
    const total = this.searchSession.matches.length;
    this.searchSession.activeIndex = (this.searchSession.activeIndex + delta + total) % total;
    this.applySearchHighlights();
    this.updateDocumentSearchCounts();
    this.renderSearchNavigator();
    this.scrollToActiveSearchHit();
  }

  scrollToActiveSearchHit() {
    const hit = document.querySelector(`.search-hit[data-search-hit="${this.searchSession?.activeIndex}"]`);
    hit?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }

  snippetForMatch(doc, match, radius = 48) {
    if (match.blockId === 'meta') {
      const text = [doc.workTitle, doc.volume, doc.chapterNumber, doc.bookStatus].filter(Boolean).join(' ');
      const from = Math.max(0, match.start - radius);
      const to = Math.min(text.length, match.end + radius);
      return `<i class="bx bx-book-open"></i> Метаданные: ${from > 0 ? '...' : ''}${escapeHtml(text.slice(from, match.start))}<mark>${escapeHtml(text.slice(match.start, match.end))}</mark>${escapeHtml(text.slice(match.end, to))}${to < text.length ? '...' : ''}`;
    }
    const block = doc.ast.blocks.find((item) => item.id === match.blockId) || doc.ast.blocks[match.blockIndex];
    const text = blockText(block);
    const from = Math.max(0, match.start - radius);
    const to = Math.min(text.length, match.end + radius);
    return `${from > 0 ? '...' : ''}${escapeHtml(text.slice(from, match.start))}<mark>${escapeHtml(text.slice(match.start, match.end))}</mark>${escapeHtml(text.slice(match.end, to))}${to < text.length ? '...' : ''}`;
  }

  openGlobalSearchWindow(seedQuery = '') {
    this.closeAllFloatingMenus();
    this.globalSearchState = { query: seedQuery || this.globalSearchState.query || '', caseSensitive: false, wholeWords: false, results: [], entitySuggestions: [] };
    this.renderGlobalSearchWindow();
    this.runGlobalSearch();
    setTimeout(() => document.getElementById('global-search-query')?.focus(), 0);
  }

  renderGlobalSearchWindow() {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal global-search-modal">
        <div class="modal-head-row">
          <div><h2>Поиск по проекту</h2><p>Результаты сгруппированы по документам.</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="global-search-controls">
          <input class="form-control" id="global-search-query" data-global-search-query value="${escapeHtml(this.globalSearchState.query || '')}" placeholder="Слово или фраза">
          <div class="global-search-options">
            <label class="nocturne-check"><input type="checkbox" data-global-search-case ${this.globalSearchState.caseSensitive ? 'checked' : ''}><span class="check-mark"></span><span>Учитывать регистр</span></label>
            <label class="nocturne-check"><input type="checkbox" data-global-search-whole ${this.globalSearchState.wholeWords ? 'checked' : ''}><span class="check-mark"></span><span>Только целые слова</span></label>
          </div>
        </div>
        <div class="global-search-results" id="global-search-results"></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  runGlobalSearch() {
    const q = this.globalSearchState.query || '';
    this.globalSearchState.results = this.state.docs
      .map((doc) => ({ doc, matches: this.collectDocMatches(doc, q, this.globalSearchState) }))
      .filter((group) => group.matches.length);
    this.globalSearchState.entitySuggestions = this.entitySuggestionsForQuery(q);
    this.renderGlobalSearchResults();
  }

  renderGlobalSearchResults() {
    const box = document.getElementById('global-search-results');
    if (!box) return;
    const q = this.globalSearchState.query.trim();
    if (!q) {
      box.innerHTML = '<div class="search-empty">Введите запрос, чтобы начать поиск.</div>';
      return;
    }
    const smart = this.globalSearchState.entitySuggestions.map((entry) => `
      <div class="smart-entity-suggestion">
        <span>${entry.kind === 'location' ? 'Найдено место' : 'Найден персонаж'}: <strong>${escapeHtml(this.entityDisplayName(entry.entity))}</strong></span>
        <button class="pill-btn ai-btn" data-action="open-entity-mentions" data-entity-kind="${entry.kind}" data-entity-id="${escapeHtml(entry.entity.id)}">Показать все упоминания</button>
      </div>`).join('');
    const results = this.globalSearchState.results.map(({ doc, matches }) => `
      <section class="search-result-doc">
        <header><strong>${escapeHtml(doc.title)}</strong><span>${matches.length} совп.</span></header>
        ${matches.slice(0, 12).map((match, index) => `
          <button class="search-snippet" data-action="open-search-result" data-doc-id="${escapeHtml(doc.id)}" data-block-id="${escapeHtml(match.blockId)}" data-match-start="${match.start}" data-query="${escapeHtml(q)}">
            ${this.snippetForMatch(doc, match)}
          </button>`).join('')}
      </section>`).join('');
    box.innerHTML = `${smart}${results || '<div class="search-empty">Совпадений нет.</div>'}`;
  }

  openSearchResult(dataset = {}) {
    const docId = dataset.docId;
    const doc = this.state.docs.find((item) => item.id === docId);
    if (!doc) return;
    document.getElementById('form-overlay')?.classList.remove('active');
    this.selectDoc(docId);
    setTimeout(() => {
      const matches = this.collectDocMatches(doc, dataset.query || '', this.globalSearchState);
      const index = Math.max(0, matches.findIndex((match) => match.blockId === dataset.blockId && Number(match.start) === Number(dataset.matchStart)));
      if (dataset.blockId === 'meta') {
        return; // Just open the document, no inline highlights needed
      }
      this.openDocumentSearch({ query: dataset.query || '', caseSensitive: this.globalSearchState.caseSensitive, wholeWords: this.globalSearchState.wholeWords, activeIndex: index });
      this.scrollToActiveSearchHit();
    }, 120);
  }

  openReplaceWindow() {
    const doc = this.getFocusedDoc();
    if (!doc) {
      this.toast('Откройте документ, чтобы использовать замену.');
      return;
    }
    this.closeAllFloatingMenus();
    this.replaceSession = {
      docId: doc.id,
      find: this.replaceSession?.find || this.searchSession?.query || '',
      replace: this.replaceSession?.replace || '',
      wholeWords: true,
      caseSensitive: false,
      preserveCase: true,
      preview: true,
      activeIndex: 0,
    };
    this.renderReplaceWindow();
    this.updateReplaceMatches();
  }

  renderReplaceWindow() {
    const overlay = document.getElementById('form-overlay');
    const s = this.replaceSession;
    overlay.innerHTML = `
      <div class="form-modal replace-modal">
        <div class="modal-head-row">
          <div><h2>Замена в документе</h2><p>${escapeHtml(this.getFocusedDoc()?.title || '')}</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="replace-fields">
          <label>Найти<input class="form-control" data-replace-find value="${escapeHtml(s.find || '')}"></label>
          <label>Заменить на<input class="form-control" data-replace-with value="${escapeHtml(s.replace || '')}"></label>
        </div>
        <section class="smart-replace-box">
          <h3>Умная замена</h3>
          ${this.replaceOption('wholeWords', 'Только целые слова', 'Не заменяет фрагменты внутри больших слов: например, "дом" не сработает в "домовой".')}
          ${this.replaceOption('caseSensitive', 'Учитывать регистр при поиске', 'Различает прописные и строчные буквы: "Дом" и "дом" будут разными совпадениями.')}
          ${this.replaceOption('preserveCase', 'Сохранять регистр при замене', 'Подстраивает замену под найденный текст: герой -> персонаж, Герой -> Персонаж, ГЕРОЙ -> ПЕРСОНАЖ.')}
          ${this.replaceOption('preview', 'Предпросмотр перед "Заменить всё"', 'Перед массовой заменой показывает количество замен и примеры фрагментов, чтобы избежать случайной правки всего документа.')}
        </section>
        <div class="replace-summary" id="replace-summary"></div>
        <div class="form-actions">
          <button class="pill-btn" data-action="replace-find-next">Найти далее</button>
          <button class="pill-btn" data-action="replace-current">Заменить текущее</button>
          <button class="pill-btn ai-btn" data-action="replace-all-preview">Заменить всё</button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  replaceOption(key, label, tip) {
    return `<label class="smart-replace-option nocturne-check"><input type="checkbox" data-replace-option="${key}" ${this.replaceSession?.[key] ? 'checked' : ''}><span class="check-mark"></span><span>${label}</span><i class="bx bx-info-circle info-icon" tabindex="0" data-tip="${escapeHtml(tip)}"></i></label>`;
  }

  updateReplaceFromControls() {
    if (!this.replaceSession) return;
    this.replaceSession.find = document.querySelector('[data-replace-find]')?.value || '';
    this.replaceSession.replace = document.querySelector('[data-replace-with]')?.value || '';
    document.querySelectorAll('[data-replace-option]').forEach((input) => { this.replaceSession[input.dataset.replaceOption] = !!input.checked; });
    this.updateReplaceMatches();
  }

  updateReplaceMatches() {
    if (!this.replaceSession) return;
    const doc = this.state.docs.find((item) => item.id === this.replaceSession.docId);
    this.replaceSession.matches = this.collectDocMatches(doc, this.replaceSession.find, this.replaceSession);
    if (this.replaceSession.activeIndex >= this.replaceSession.matches.length) this.replaceSession.activeIndex = Math.max(0, this.replaceSession.matches.length - 1);
    const summary = document.getElementById('replace-summary');
    if (summary) summary.innerHTML = this.replaceSession.find ? `Найдено: <strong>${this.replaceSession.matches.length}</strong>` : 'Введите текст для поиска.';
  }

  replacementWithCase(found, replacement) {
    if (!this.replaceSession?.preserveCase || !found) return replacement;
    if (found === found.toUpperCase()) return replacement.toUpperCase();
    if (found[0] === found[0]?.toUpperCase() && found.slice(1) === found.slice(1).toLowerCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
  }

  replaceInHtmlRange(html, start, end, replacement) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const { textNodes } = this.textNodesForHighlightBlock(div);
    const startPart = textNodes.find((part) => start >= part.start && start < part.end)
      || textNodes.find((part) => start === part.end);
    const endPart = textNodes.find((part) => end > part.start && end <= part.end)
      || textNodes.find((part) => end === part.start);
    if (startPart && startPart === endPart) {
      const localStart = Math.max(0, start - startPart.start);
      const localEnd = Math.max(localStart, end - startPart.start);
      startPart.node.nodeValue = `${startPart.node.nodeValue.slice(0, localStart)}${replacement}${startPart.node.nodeValue.slice(localEnd)}`;
      return normalizeHtml(div.innerHTML || '<br>');
    }
    const range = this.rangeFromBlockOffsets(textNodes, start, end);
    if (!range) return html;
    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
    return normalizeHtml(div.innerHTML || '<br>');
  }

  replaceInHtmlRangeWithHtml(html, start, end, replacementHtml) {
    const div = document.createElement('div');
    div.innerHTML = html || '';
    const { textNodes } = this.textNodesForHighlightBlock(div);
    const range = this.rangeFromBlockOffsets(textNodes, start, end);
    if (!range) return html;
    const template = document.createElement('template');
    template.innerHTML = replacementHtml || '';
    range.deleteContents();
    range.insertNode(template.content.cloneNode(true));
    return normalizeHtml(div.innerHTML || '<br>');
  }

  applyTypoReplacement(match) {
    if (!match?.docId || !match.blockId) return false;
    const doc = this.state.docs.find((item) => item.id === match.docId);
    const block = doc?.ast?.blocks?.find((item) => item.id === match.blockId);
    if (!doc || !block) return false;
    const current = blockText(block).slice(match.startOffset, match.endOffset);
    if (normalizeTypoToken(current) !== normalizeTypoToken(match.rawText)) {
      this.toast('Фрагмент уже изменился. Повторите действие.');
      this.updateTypoHighlightsDebounced();
      return false;
    }
    block.html = this.replaceInHtmlRange(block.html, match.startOffset, match.endOffset, match.correct);
    doc.updatedAt = Date.now();
    doc.summary = doc.description || buildSummary(doc.ast);
    this.bumpDocRenderRevision(doc);
    this.writeLiveDraft(doc.id);
    this.saveDocByIdDebounced(doc.id);
    this.renderWorkspacePane(match.paneId || this.state.workspace?.focusedPaneId || 'primary');
    this.updateTypoHighlightsDebounced();
    return true;
  }

  applyReplaceMatch(match) {
    const doc = this.state.docs.find((item) => item.id === match.docId);
    const block = doc?.ast?.blocks?.find((item) => item.id === match.blockId);
    if (!doc || !block) return false;
    const current = blockText(block).slice(match.start, match.end);
    const expected = String(match.text || '');
    const same = this.replaceSession?.caseSensitive
      ? current === expected
      : current.toLocaleLowerCase('ru-RU') === expected.toLocaleLowerCase('ru-RU');
    if (!same || (this.replaceSession?.wholeWords && !this.isWholeWordMatch(blockText(block), match.start, match.end))) {
      this.toast('Фрагмент изменился, обновите поиск.');
      this.updateReplaceMatches();
      return false;
    }
    const replacement = this.replacementWithCase(match.text, this.replaceSession.replace || '');
    block.html = this.replaceInHtmlRange(block.html, match.start, match.end, replacement);
    doc.updatedAt = Date.now();
    doc.summary = doc.description || buildSummary(doc.ast);
    this.bumpDocRenderRevision(doc);
    this.writeLiveDraft(doc.id);
    this.saveDocByIdDebounced(doc.id);
    return true;
  }

  replaceFindNext() {
    this.updateReplaceMatches();
    if (!this.replaceSession?.matches?.length) {
      this.toast('Совпадений не найдено.');
      return;
    }
    this.replaceSession.activeIndex = (this.replaceSession.activeIndex + 1) % this.replaceSession.matches.length;
    const match = this.replaceSession.matches[this.replaceSession.activeIndex];
    this.openDocumentSearch({ query: this.replaceSession.find, wholeWords: this.replaceSession.wholeWords, caseSensitive: this.replaceSession.caseSensitive, activeIndex: this.replaceSession.activeIndex });
    this.scrollToActiveSearchHit();
    document.getElementById('form-overlay')?.classList.add('active');
    return match;
  }

  replaceCurrentMatch() {
    this.updateReplaceMatches();
    const match = this.replaceSession?.matches?.[this.replaceSession.activeIndex || 0];
    if (!match) {
      this.toast('Совпадений не найдено.');
      return;
    }
    if (this.applyReplaceMatch(match)) {
      this.renderWorkspacePane(this.state.workspace?.focusedPaneId || 'primary');
      this.updateReplaceMatches();
      this.toast('Совпадение заменено.');
      this.replaceFindNext();
    }
  }

  showReplaceAllPreview() {
    this.updateReplaceMatches();
    const matches = this.replaceSession?.matches || [];
    if (!matches.length) {
      this.toast('Совпадений не найдено.');
      return;
    }
    if (!this.replaceSession.preview) return this.confirmReplaceAll();
    const doc = this.state.docs.find((item) => item.id === this.replaceSession.docId);
    const summary = document.getElementById('replace-summary');
    if (!summary) return;
    summary.innerHTML = `
      <div class="replace-preview">
        <strong>Будет заменено: ${matches.length}</strong>
        ${matches.slice(0, 8).map((match) => `<div>${this.snippetForMatch(doc, match, 36)}</div>`).join('')}
        <button class="pill-btn ai-btn" data-action="confirm-replace-all">Подтвердить замену всех</button>
      </div>`;
  }

  confirmReplaceAll() {
    this.updateReplaceMatches();
    const matches = [...(this.replaceSession?.matches || [])].sort((a, b) => b.blockIndex - a.blockIndex || b.start - a.start);
    if (!matches.length) {
      this.toast('Совпадений не найдено.');
      return;
    }
    matches.forEach((match) => this.applyReplaceMatch(match));
    const paneId = this.state.workspace?.focusedPaneId || 'primary';
    this.renderWorkspacePane(paneId);
    this.updateReplaceMatches();
    this.toast(`Заменено ${matches.length} совпадений.`);
  }

  entitySuggestionsForQuery(query) {
    const normalized = normalizeTypoToken(query || '');
    if (!normalized) return [];
    const suggestions = [];
    const push = (kind, entity) => {
      if (!suggestions.some((item) => item.kind === kind && item.entity.id === entity.id)) suggestions.push({ kind, entity });
    };
    this.state.lore.characters.forEach((entity) => {
      if (this.entityMentionValues(entity).some((value) => normalizeTypoToken(value) === normalized)) push('character', entity);
    });
    this.state.lore.locations.forEach((entity) => {
      if (this.entityMentionValues(entity).some((value) => normalizeTypoToken(value) === normalized)) push('location', entity);
    });
    return suggestions;
  }

  entityForKindId(kind, id) {
    const list = kind === 'location' ? this.state.lore.locations : this.state.lore.characters;
    return list.find((item) => item.id === id);
  }

  openEntityMentions(kind, id) {
    const entity = this.entityForKindId(kind, id);
    if (!entity) return;
    const variants = this.entityMentionValues(entity).sort((a, b) => b.length - a.length);
    const groups = this.state.docs.map((doc) => {
      const all = [];
      variants.forEach((variant) => all.push(...this.collectDocMatches(doc, variant, { caseSensitive: false, wholeWords: true }).map((match) => ({ ...match, variant }))));
      const seen = new Set();
      const matches = all.sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start).filter((match) => {
        const key = `${match.blockId}:${match.start}:${match.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { doc, matches };
    }).filter((group) => group.matches.length);
    const total = groups.reduce((sum, group) => sum + group.matches.length, 0);
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal global-search-modal mentions-modal">
        <div class="modal-head-row">
          <div>
            <h2>Все упоминания: ${escapeHtml(this.entityDisplayName(entity))}</h2>
            <p>${kind === 'location' ? 'Локация' : 'Персонаж'} · ${total} упоминаний · ${groups.length} документов</p>
          </div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <p class="mentions-variants">Учитывались варианты: ${escapeHtml(variants.slice(0, 8).join(', '))}</p>
        <div class="global-search-results">
          ${groups.length ? groups.map(({ doc, matches }) => `
            <section class="search-result-doc">
              <header><strong>${escapeHtml(doc.title)}</strong><span>${matches.length} упомин.</span></header>
              ${matches.slice(0, 18).map((match) => `
                <button class="search-snippet" data-action="open-search-result" data-doc-id="${escapeHtml(doc.id)}" data-block-id="${escapeHtml(match.blockId)}" data-match-start="${match.start}" data-query="${escapeHtml(match.variant)}">
                  ${this.snippetForMatch(doc, match)}
                </button>`).join('')}
            </section>`).join('') : this.emptyStateMarkup('bx-search-alt', 'Упоминаний нет.', 'Эта сущность пока не встречается в документах.')}
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }



  scheduleLiveEntityRefresh(editable, inputEvent = null) {
    if (!editable || inputEvent?.isComposing) return;
    if (this.shouldRefreshEntityLinks(inputEvent)) {
      this.liveEntityRefreshDebounced(editable);
    } else if ((inputEvent?.inputType || '') === 'insertText') {
      this.liveEntityRefreshSlowDebounced(editable);
    }
  }

  shouldRefreshEntityLinks(inputEvent) {
    if (!this.buildEntityMentionIndex().length) return false;
    if (!inputEvent) return true;
    const inputType = inputEvent.inputType || '';
    const inserted = inputEvent.data || '';
    if (inputType === 'insertFromPaste' || inputType === 'insertLineBreak' || inputType === 'insertParagraph') return true;
    if (/^delete/u.test(inputType) || inputType === 'deleteByCut') return true;
    if (inputType === 'insertText') return /[\s.,!?;:()\[\]{}"'\u00ab\u00bb\u201c\u201d\u2018\u2019\u2014\u2013-]/u.test(inserted || this.lastEditKey || '');
    return true;
  }

  refreshEntityLinksNearCaret(editable) {
  }

  refreshVisibleEntityLinks() {
    if (!this.nocturneEditor) return;
    for (const instance of this.nocturneEditor.instances.values()) {
      const { editor } = instance;
      if (editor?.view) {
        editor.view.dispatch(editor.view.state.tr.setMeta('nocturneEntityMentionsForceUpdate', true));
      }
    }
  }

  refreshEntityLinksInBlock(block, snapshot = this.getCaretSnapshot(), restore = true) {
  }

  stripEntityMarkup(root) {
    root.querySelectorAll?.('.entity-link').forEach((node) => {
      node.replaceWith(document.createTextNode(cleanAnalysisResidue(node.textContent || '').replace(/\uFEFF/g, '')));
    });
  }

  shouldRefreshTypoHighlights(inputEvent) {
    if (!this.state.settings.strictSpellcheck) return true;
    if (!inputEvent) return true;
    const inputType = inputEvent.inputType || '';
    const inserted = inputEvent.data || '';
    if (inputType === 'insertFromPaste' || inputType === 'insertLineBreak' || inputType === 'insertParagraph') return true;
    if (/^delete/u.test(inputType) || inputType === 'deleteByCut') return true;
    if (inputType === 'insertText') return /[\s.,!?;:()\[\]{}"'\u00ab\u00bb\u201c\u201d\u2018\u2019\u2014\u2013-]/u.test(inserted || this.lastEditKey || '');
    return false;
  }

  shouldRefreshReadability(inputEvent) {
    if (!this.state.settings.readability) return false;
    const inserted = inputEvent?.data || '';
    if (/[.!?…]/u.test(inserted)) return true;
    if (inputEvent?.inputType === 'insertFromPaste') return true;
    return inputEvent?.inputType === 'insertText' && /[.!?…]/u.test(this.lastEditKey || '');
  }

  updateReadabilityForTyping(inputEvent) {
    if (!this.state.settings.readability || !inputEvent) return;
    if (!/^(insertText|deleteContentBackward|deleteContentForward|deleteByCut)$/u.test(inputEvent.inputType || '')) return;
    this.updateReadabilityHighlights({ skipActiveSentence: true });
  }

  cleanEditableAnalysis(editable) {
    if (!editable.querySelector('.entity-link,.syntax-dialogue,.syntax-thought,.weak-word,.sentence-long,.sentence-short,.ai-suggestion,[data-analysis]')) return;
    const snapshot = this.getCaretSnapshot();
    stripAnalysisMarkup(editable);
    this.restoreCaret(snapshot);
  }

  writeLiveDraft(docId = this.getFocusedDoc()?.id || this.state.activeDocId) {
    const doc = this.state.docs.find((item) => item.id === docId);
    if (!doc || doc.locked || !this.state.settings.liveSave) return;
    if (this.state.settings.e2e) {
      return;
    }
    const ok = safeSetStorageItem(localStorage, `${LIVE_PREFIX}${doc.id}`, JSON.stringify({
      ast: doc.ast,
      notes: doc.notes || '',
      updatedAt: doc.updatedAt || Date.now(),
    }));
    if (!ok) {
      this.toast('Live-save переполнен: браузер не дал записать черновик.');
    }
  }

  async createSnapshot(showToast = false) {
    const doc = this.activeDoc;
    if (!doc || doc.locked) return;
    await this.saveActiveDoc({ silent: true });
    const snapshot = {
      id: uid('snap'),
      docId: doc.id,
      title: doc.title,
      createdAt: Date.now(),
      ast: structuredClone(doc.ast),
      notes: doc.notes || '',
      globalNotes: this.state.globalNotes || '',
      summary: doc.summary || doc.description,
      wordCount: countWords(docText(doc.ast)),
    };
    await this.db.put('snapshots', snapshot);
    await this.pruneSnapshots(doc.id);
    if (this.state.settings.gitVersioning) {
      try {
        const dump = await this.buildNocturneDump();
        const data = JSON.stringify(dump, null, 2);
        const projectName = dump.projectTitle || 'nocturne-project';
        await platformFiles.saveGitSnapshot(data, projectName);
      } catch (err) {
        console.warn('Manual git snapshot failed:', err);
      }
    }
    if (showToast) this.toast('Снапшот создан вручную.');
  }

  async pruneSnapshots(docId, limit = 30) {
    const snapshots = (await this.db.getAll('snapshots'))
      .filter((snap) => snap.docId === docId)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    await Promise.all(snapshots.slice(limit).map((snap) => this.db.delete('snapshots', snap.id)));
  }

  async saveActiveDoc(options = {}) {
    return this.saveDocById(this.getFocusedDoc()?.id || null, options);
  }

  saveDocByIdDebounced(docId) {
    if (!docId) return;
    this.setSaveStatus('saving', docId);
    if (!this.saveDocDebouncers.has(docId)) {
      this.saveDocDebouncers.set(docId, debounce(() => this.saveDocById(docId, { silent: true }), 450));
    }
    this.saveDocDebouncers.get(docId)();
  }

  async saveDocById(docId, options = {}) {
    const doc = this.state.docs.find((item) => item.id === docId);
    if (!doc || doc.locked) return;
    this.setSaveStatus('saving', doc.id);
    if (this.state.settings.e2e && !this.state.sessionPassword) {
      this.setSaveStatus('error', doc.id, 'Нужен мастер-пароль сессии для зашифрованного сохранения.');
      if (!options.silent) this.toast('Введите мастер-пароль сессии перед сохранением.');
      return;
    }
    if (this.state.settings.loreReaction === 'hard' && this.hasHardLoreConflict(doc)) {
      this.setSaveStatus('error', doc.id, 'Сохранение заблокировано: конфликт с лором.');
      this.toast('Сохранение заблокировано: найден конфликт с лором.');
      return;
    }
    try {
      const stored = { ...doc };
      if (this.state.settings.e2e && this.state.sessionPassword) {
        stored.encrypted = await encryptJson({ ast: doc.ast, notes: doc.notes, summary: doc.summary, title: doc.title, description: doc.description }, this.state.sessionPassword);
        delete stored.ast;
        delete stored.notes;
        delete stored.summary;
        stored.title = 'Encrypted document';
        stored.description = 'Encrypted document';
        stored.summary = 'Encrypted document';
      } else {
        delete stored.encrypted;
      }
      await this.db.put('docs', stored);
      if (!stored.encrypted) safeRemoveStorageItem(localStorage, `${LIVE_PREFIX}${doc.id}`);
      await this.updateTodayStats(doc.id);
      this.drawSentiment();
      this.setSaveStatus('saved', doc.id);
      if (!options.silent) this.toast('Сохранено.');
    } catch (error) {
      this.setSaveStatus('error', doc.id, error?.message || 'IndexedDB не принял сохранение.');
      const quota = /quota|disk|storage/i.test(error?.name || error?.message || '');
      if (!options.silent) this.toast(quota ? 'Недостаточно места для сохранения. Экспортируйте проект или удалите старые снапшоты.' : 'Ошибка сохранения.');
    }
  }

  renderNotes() {
    const container = document.getElementById('notes-panel');
    if (!container) return;
    let input = document.getElementById('notes-input');
    if (!input) return;
    
    const text = this.state.noteMode === 'global' ? this.state.globalNotes : (this.activeDoc?.notes || '');
    
    // Parse markdown checkboxes to interactive HTML
    const html = text.split('\n').map(line => {
      if (line.trim().startsWith('- [ ] ')) return `<div class="cb-line"><label class="interactive-cb"><input type="checkbox"><span></span></label> ${escapeHtml(line.replace('- [ ] ', ''))}</div>`;
      if (line.trim().startsWith('- [x] ')) return `<div class="cb-line"><label class="interactive-cb"><input type="checkbox" checked><span></span></label> ${escapeHtml(line.replace('- [x] ', ''))}</div>`;
      return `<div>${escapeHtml(line) || '<br>'}</div>`;
    }).join('');
    
    // Check if user is typing
    if (document.activeElement !== input) {
      input.innerHTML = html;
    }

    document.querySelectorAll('.notes-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.notesMode === this.state.noteMode);
      if (!tab.dataset.action) tab.dataset.action = 'switch-notes';
    });
    this.renderFloatingNotesManager();
  }

  floatingNoteScopeForContext() {
    const doc = this.getFocusedDoc();
    if (doc) return { scope: 'document', linkedId: doc.id };
    const pane = this.getFocusedPane();
    if ((pane?.type === 'character-detail' || pane?.type === 'location-detail' || pane?.type === 'note-detail') && pane.entityId) {
      return { scope: pane.entityType === 'location' ? 'location' : pane.entityType === 'note' ? 'note' : 'character', linkedId: pane.entityId };
    }
    return { scope: 'global', linkedId: null };
  }

  floatingNoteVisible(note) {
    if (note.hidden) return false;
    if (note.forceVisible) return true;
    if (this.state.floatingNotesShowAll || note.scope === 'global') return true;
    if (note.temporary) return true;
    if (note.scope === 'document') {
      const paneDocs = Object.values(this.state.workspace?.panes || {})
        .filter((pane) => pane.type === 'document')
        .map((pane) => pane.docId);
      return paneDocs.includes(note.linkedId);
    }
    if (note.scope === 'character' || note.scope === 'location') {
      const detail = this.state.activeLoreDetail;
      const modalActive = document.getElementById('kb-modal')?.classList.contains('active');
      if (modalActive && detail?.id === note.linkedId && this.singularLoreType(detail.type) === note.scope) return true;
      return Object.values(this.state.workspace?.panes || {}).some((pane) => (
        pane.type === `${note.scope}-detail` && pane.entityId === note.linkedId
      ));
    }
    return false;
  }

  floatingNoteScopeLabel(note) {
    if (note.temporary) return 'Временная';
    if (note.scope === 'global') return 'Общая';
    if (note.scope === 'document') return this.state.docs.find((doc) => doc.id === note.linkedId)?.title || 'Документ';
    const list = note.scope === 'location' ? this.state.lore.locations : this.state.lore.characters;
    return this.entityDisplayName(list.find((item) => item.id === note.linkedId)) || (note.scope === 'location' ? 'Локация' : 'Персонаж');
  }

  floatingNoteTypeLabel(note) {
    if (note.temporary) return 'Временная';
    if (note.scope === 'document') return 'Документ';
    if (note.scope === 'character') return 'Персонаж';
    if (note.scope === 'location') return 'Локация';
    return 'Общая';
  }

  renderFloatingNoteMenu() {
    const popover = document.getElementById('floating-note-popover');
    if (!popover) return;
    const doc = this.getFocusedDoc();
    popover.innerHTML = `
      <button class="floating-menu-item ${doc ? '' : 'disabled'}" data-action="create-document-floating-note" ${doc ? '' : 'disabled'}>
        <i class="bx bx-file"></i>
        <span>${doc ? 'Заметка для текущего документа' : 'Нет активного документа'}<small>${escapeHtml(doc?.title || 'Откройте документ в рабочей области')}</small></span>
      </button>
      <button class="floating-menu-item" data-action="create-global-floating-note">
        <i class="bx bx-globe"></i>
        <span>Общая заметка<small>Видна всегда</small></span>
      </button>
      <button class="floating-menu-item temporary" data-action="create-temporary-floating-note">
        <i class="bx bx-time-five"></i>
        <span>Временная заметка<small>Исчезнет после перезагрузки</small></span>
      </button>
      <button class="floating-menu-item all-notes" data-action="open-floating-notes-manager">
        <i class="bx bx-list-ul"></i>
        <span>Все заметки<small>Полный менеджер окон</small></span>
      </button>
    `;
  }

  showFloatingNoteMenu() {
    this.renderFloatingNoteMenu();
    clearTimeout(this.floatingNotesMenuHideTimer);
    this.openFloatingMenu('notes');
  }

  toggleFloatingNoteMenu() {
    const popover = document.getElementById('floating-note-popover');
    if (popover?.classList.contains('active')) {
      this.hideFloatingNoteMenu();
      return;
    }
    this.showFloatingNoteMenu();
  }

  hideFloatingNoteMenu() {
    clearTimeout(this.floatingNotesMenuHideTimer);
    this.closeFloatingMenu('notes');
  }

  scheduleHideFloatingNoteMenu() {
    clearTimeout(this.floatingNotesMenuHideTimer);
    this.floatingNotesMenuHideTimer = setTimeout(() => {
      if (!this.floatingNotesMenuAnchorHovered && !this.floatingNotesMenuHovered) this.hideFloatingNoteMenu();
    }, 220);
  }

  handleFloatingNoteMenuMouseOver(event) {
    if (event.target.closest?.('[data-floating-note-menu-anchor]')) {
      this.floatingNotesMenuAnchorHovered = true;
      return;
    }
    if (event.target.closest?.('#floating-note-popover')) {
      this.floatingNotesMenuHovered = true;
      clearTimeout(this.floatingNotesMenuHideTimer);
    }
  }

  handleFloatingNoteMenuMouseOut(event) {
    if (event.target.closest?.('[data-floating-note-menu-anchor]')) this.floatingNotesMenuAnchorHovered = false;
    if (event.target.closest?.('#floating-note-popover')) this.floatingNotesMenuHovered = false;
  }

  renderFloatingNotesModal() {
    const modal = document.getElementById('floating-notes-modal');
    if (!modal) return;
    if (!this.state.floatingNotesManagerOpen) {
      modal.classList.remove('active');
      modal.innerHTML = '';
      return;
    }
    const notes = [...this.state.floatingNotes].sort((a, b) => b.updatedAt - a.updatedAt);
    const groups = [
      ['Общие заметки', notes.filter((note) => note.scope === 'global' && !note.temporary), 'Пока нет общих заметок.'],
      ['Заметки документов', notes.filter((note) => note.scope === 'document' && !note.temporary), 'Пока нет заметок документов.'],
      ['Временные заметки', notes.filter((note) => note.temporary), 'Пока нет временных заметок.'],
      ['Заметки персонажей и локаций', notes.filter((note) => ['character', 'location'].includes(note.scope) && !note.temporary), 'Пока нет заметок к досье.'],
    ];
    const counts = {
      total: notes.length,
      global: notes.filter((note) => note.scope === 'global' && !note.temporary).length,
      document: notes.filter((note) => note.scope === 'document' && !note.temporary).length,
      temporary: notes.filter((note) => note.temporary).length,
    };
    modal.innerHTML = `
      <section class="floating-notes-modal-panel">
        <header class="floating-notes-modal-head">
          <div>
            <h2>Все заметки</h2>
            <p>Всего ${counts.total} · общие ${counts.global} · документы ${counts.document} · временные ${counts.temporary}</p>
          </div>
          <button class="btn-icon" data-action="close-floating-notes-manager"><i class="bx bx-x"></i></button>
        </header>
        <div class="floating-notes-modal-body">
          ${groups.map(([title, groupNotes, empty]) => this.renderFloatingNotesModalSection(title, groupNotes, empty)).join('')}
        </div>
      </section>
    `;
    modal.classList.add('active');
  }

  renderFloatingNotesModalSection(title, notes, empty) {
    return `<section class="floating-manager-section">
      <h3>${escapeHtml(title)}</h3>
      ${notes.length ? `<div class="floating-manager-grid">${notes.map((note) => this.renderFloatingNoteManagerCard(note)).join('')}</div>` : `<p class="floating-manager-empty">${escapeHtml(empty)}</p>`}
    </section>`;
  }

  renderFloatingNoteManagerCard(note) {
    const body = (note.body || '').trim() || 'Без текста';
    return `<article class="floating-manager-card ${note.temporary ? 'temporary' : ''}" data-note-id="${note.id}">
      <div class="floating-manager-card-top">
        <span>${escapeHtml(this.floatingNoteTypeLabel(note))}</span>
        <small>${escapeHtml(this.floatingNoteScopeLabel(note))}</small>
      </div>
      <h4>${escapeHtml(note.title || 'Заметка')}</h4>
      <p>${escapeHtml(body)}</p>
      <div class="floating-manager-card-actions">
        <button class="pill-btn" data-action="focus-floating-note" data-note-id="${note.id}"><i class="bx bx-show"></i> Показать</button>
        <button class="pill-btn danger-btn" data-action="delete-floating-note" data-note-id="${note.id}"><i class="bx bx-trash"></i></button>
      </div>
    </article>`;
  }

  renderFloatingNotesManager() {
    const manager = document.getElementById('floating-notes-manager');
    if (!manager) return;
    const visibleCount = this.state.floatingNotes.filter((note) => this.floatingNoteVisible(note)).length;
    const total = this.state.floatingNotes.length;
    const items = [...this.state.floatingNotes]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 6)
      .map((note) => `<button class="floating-note-list-item" data-action="focus-floating-note" data-note-id="${note.id}">
        <span>${escapeHtml(note.title || 'Заметка')}</span>
        <small>${escapeHtml(this.floatingNoteScopeLabel(note))}</small>
      </button>`).join('');
    manager.innerHTML = `
      <div class="floating-manager-head">
        <div><strong>Плавающие заметки</strong><span>${visibleCount} / ${total}</span></div>
        <div>
          <button class="mini-icon-btn" data-action="toggle-floating-notes-show-all" title="Показать все"><i class="bx ${this.state.floatingNotesShowAll ? 'bx-hide' : 'bx-show'}"></i></button>
          <button class="mini-icon-btn" data-action="open-floating-notes-manager" title="Все заметки"><i class="bx bx-list-ul"></i></button>
          <button class="mini-icon-btn" data-action="new-floating-note" title="Новая"><i class="bx bx-plus"></i></button>
        </div>
      </div>
      ${items ? `<div class="floating-note-list">${items}</div>` : '<p class="floating-manager-empty">Окон заметок пока нет.</p>'}
    `;
  }

  renderFloatingNotes() {
    const layer = document.getElementById('floating-notes-layer');
    if (!layer) return;
    const notes = this.state.floatingNotes.filter((note) => this.floatingNoteVisible(note));
    layer.innerHTML = notes.map((note) => this.renderFloatingNote(note)).join('');
    this.renderFloatingNotesManager();
  }

  renderFloatingNote(note) {
    const body = escapeHtml(note.body || '').replace(/\n/g, '<br>');
    const title = escapeHtml(note.title || 'Новая заметка');
    const max = this.clampFloatingNoteRect(note);
    const classes = ['floating-note', note.minimized ? 'minimized' : '', note.pinned ? 'pinned' : '', note.temporary ? 'temporary' : ''].filter(Boolean).join(' ');
    return `<article class="${classes}" data-note-id="${note.id}" style="left:${max.x}px;top:${max.y}px;width:${max.width}px;height:${note.minimized ? '42' : max.height}px;z-index:${note.zIndex + (note.pinned ? 500 : 0)}">
      <header class="floating-note-header">
        <span class="floating-note-drag-handle" aria-hidden="true"><i class="bx bx-grid-vertical"></i></span>
        <div class="floating-note-title" tabindex="0" data-floating-title data-placeholder="Новая заметка">${title}</div>
        <div class="floating-note-actions">
          <button type="button" data-action="toggle-floating-note-pin" data-floating-pin title="Закрепить"><i class="bx ${note.pinned ? 'bxs-pin' : 'bx-pin'}"></i></button>
          <button type="button" data-action="rename-floating-note" title="Переименовать"><i class="bx bx-pencil"></i></button>
          <button type="button" data-action="toggle-floating-note-minimized" data-floating-minimize title="Свернуть"><i class="bx ${note.minimized ? 'bx-chevron-up' : 'bx-chevron-down'}"></i></button>
          <button type="button" data-action="close-floating-note" title="Закрыть окно"><i class="bx bx-x"></i></button>
          <button type="button" data-action="delete-floating-note" title="Удалить"><i class="bx bx-trash"></i></button>
        </div>
      </header>
      <div class="floating-note-meta">${escapeHtml(this.floatingNoteScopeLabel(note))}</div>
      <div class="floating-note-body" contenteditable="true" spellcheck="false" data-floating-field="body" data-placeholder="Запишите мысль...">${body}</div>
      <div class="floating-note-resizer"></div>
    </article>`;
  }

  async createFloatingNote(options = {}) {
    const context = options.scope ? { scope: options.scope, linkedId: options.linkedId || null } : this.floatingNoteScopeForContext();
    const cascade = this.state.floatingNotes.length % 8;
    const width = 320;
    const height = 260;
    const x = Math.min(window.innerWidth - width - 28, Math.max(260, window.innerWidth * .58 + cascade * 22));
    const y = Math.min(window.innerHeight - 90, Math.max(86, 130 + cascade * 24));
    const now = Date.now();
    const note = this.sanitizeFloatingNote({
      id: uid('float-note'),
      title: options.title || 'Новая заметка',
      body: options.body || '',
      ...context,
      x,
      y,
      width,
      height,
      zIndex: this.nextFloatingNoteZIndex(),
      minimized: false,
      pinned: false,
      temporary: !!options.temporary,
      hidden: false,
      forceVisible: !!options.forceVisible,
      createdAt: now,
      updatedAt: now,
    });
    this.state.floatingNotes.push(note);
    if (!note.temporary) await this.db.put('floatingNotes', { ...note, forceVisible: false });
    this.renderFloatingNotes();
    if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
    requestAnimationFrame(() => {
      document.querySelector(`.floating-note[data-note-id="${note.id}"] .floating-note-body`)?.focus();
    });
    return note;
  }

  updateFloatingNote(id, patch, options = {}) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    Object.assign(note, patch, { updatedAt: Date.now() });
    const clamped = this.clampFloatingNoteRect(note);
    Object.assign(note, clamped);
    if (options.save !== false) {
      if (options.immediate) this.saveFloatingNoteNow(id);
      else this.saveFloatingNoteDebounced(id);
    }
    if (options.render !== false) this.renderFloatingNotes();
  }

  async closeFloatingNote(id) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    if (note.temporary) {
      await this.deleteFloatingNote(id);
      return;
    }
    note.hidden = true;
    note.forceVisible = false;
    note.updatedAt = Date.now();
    await this.db.put('floatingNotes', { ...note, forceVisible: false });
    this.renderFloatingNotes();
    this.renderFloatingNotesManager();
    if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
  }

  async deleteFloatingNote(id) {
    const element = document.querySelector(`.floating-note[data-note-id="${id}"]`);
    const note = this.state.floatingNotes.find((item) => item.id === id);
    element?.classList.add('closing');
    if (note && !note.temporary) await this.db.delete('floatingNotes', id);
    this.state.floatingNotes = this.state.floatingNotes.filter((note) => note.id !== id);
    setTimeout(() => {
      this.renderFloatingNotes();
      this.renderFloatingNotesModal();
    }, element ? 150 : 0);
  }

  bringFloatingNoteToFront(id, options = {}) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    const zIndex = this.nextFloatingNoteZIndex();
    note.zIndex = zIndex;
    note.updatedAt = Date.now();
    const element = document.querySelector(`.floating-note[data-note-id="${id}"]`);
    if (element) element.style.zIndex = String(zIndex + (note.pinned ? 500 : 0));
    this.saveFloatingNoteDebounced(id);
    if (options.render) this.renderFloatingNotes();
    this.renderFloatingNotesManager();
  }

  nextFloatingNoteZIndex() {
    return Math.max(100, ...this.state.floatingNotes.map((note) => Number(note.zIndex) || 100)) + 1;
  }

  saveFloatingNoteDebounced(id) {
    if (!id) return;
    if (!this.saveFloatingNoteDebouncers.has(id)) {
      this.saveFloatingNoteDebouncers.set(id, debounce(async () => {
        const note = this.state.floatingNotes.find((item) => item.id === id);
        if (note && !note.temporary) {
          try {
            await this.db.put('floatingNotes', { ...note, forceVisible: false });
          } catch {
            this.toast('Не удалось сохранить плавающую заметку.');
          }
        }
      }, 220));
    }
    this.saveFloatingNoteDebouncers.get(id)();
  }

  async saveFloatingNoteNow(id) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (note && !note.temporary) {
      try {
        await this.db.put('floatingNotes', { ...note, forceVisible: false });
      } catch {
        this.toast('Не удалось сохранить плавающую заметку.');
      }
    }
  }

  handleFloatingNoteInput(field) {
    const noteEl = field.closest('.floating-note');
    const id = noteEl?.dataset.noteId;
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    if (field.dataset.floatingField === 'title') {
      return;
    } else {
      note.body = field.innerText || '';
    }
    note.updatedAt = Date.now();
    this.saveFloatingNoteDebounced(id);
    this.renderFloatingNotesManager();
    if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
  }

  beginFloatingNoteRename(titleEl) {
    const noteEl = titleEl.closest('.floating-note');
    const note = this.state.floatingNotes.find((item) => item.id === noteEl?.dataset.noteId);
    if (!note) return;
    titleEl.dataset.renameOriginal = note.title || 'Без названия';
    titleEl.setAttribute('contenteditable', 'true');
    titleEl.dataset.floatingField = 'title';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  commitFloatingNoteRename(titleEl) {
    const noteEl = titleEl.closest('.floating-note');
    const id = noteEl?.dataset.noteId;
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    const nextTitle = (titleEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Без названия';
    note.title = nextTitle;
    note.updatedAt = Date.now();
    titleEl.textContent = nextTitle;
    titleEl.removeAttribute('contenteditable');
    delete titleEl.dataset.floatingField;
    delete titleEl.dataset.renameOriginal;
    this.saveFloatingNoteNow(id);
    this.renderFloatingNotesManager();
    if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
  }

  cancelFloatingNoteRename(titleEl) {
    const original = titleEl.dataset.renameOriginal || 'Без названия';
    titleEl.textContent = original;
    titleEl.removeAttribute('contenteditable');
    delete titleEl.dataset.floatingField;
    delete titleEl.dataset.renameOriginal;
  }

  toggleFloatingNotePinned(id) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    note.pinned = !note.pinned;
    note.updatedAt = Date.now();
    const el = document.querySelector(`.floating-note[data-note-id="${id}"]`);
    if (el) {
      el.classList.toggle('pinned', note.pinned);
      el.style.zIndex = String(note.zIndex + (note.pinned ? 500 : 0));
      const icon = el.querySelector('[data-floating-pin] i');
      icon?.classList.toggle('bxs-pin', note.pinned);
      icon?.classList.toggle('bx-pin', !note.pinned);
      el.querySelector('[data-floating-pin]')?.classList.add('note-pin-pulse');
      setTimeout(() => el.querySelector('[data-floating-pin]')?.classList.remove('note-pin-pulse'), 260);
    }
    this.saveFloatingNoteNow(id);
    this.renderFloatingNotesManager();
    if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
  }

  toggleFloatingNoteMinimized(id) {
    const note = this.state.floatingNotes.find((item) => item.id === id);
    const el = document.querySelector(`.floating-note[data-note-id="${id}"]`);
    if (!note || !el || el.classList.contains('animating-minimize')) return;
    const body = el.querySelector('.floating-note-body');
    const meta = el.querySelector('.floating-note-meta');
    const buttonIcon = el.querySelector('[data-floating-minimize] i');
    const wasMinimized = !!note.minimized;
    const collapsedHeight = el.querySelector('.floating-note-header')?.getBoundingClientRect().height || 42;
    const expandedHeight = Math.max(160, Number(note.height) || 260);
    el.classList.add('animating-minimize');
    el.style.overflow = 'hidden';
    el.style.transition = 'height 240ms cubic-bezier(.16, 1, .3, 1)';
    [body, meta].forEach((part) => {
      if (!part) return;
      part.style.transition = 'opacity 170ms ease, transform 170ms ease';
    });

    const cleanup = () => {
      el.classList.toggle('minimized', note.minimized);
      el.classList.remove('animating-minimize');
      el.style.transition = '';
      el.style.overflow = '';
      [body, meta].forEach((part) => {
        if (!part) return;
        part.style.transition = '';
        part.style.opacity = '';
        part.style.transform = '';
      });
      buttonIcon?.classList.toggle('bx-chevron-up', note.minimized);
      buttonIcon?.classList.toggle('bx-chevron-down', !note.minimized);
      this.saveFloatingNoteNow(id);
      this.renderFloatingNotesManager();
      if (this.state.floatingNotesManagerOpen) this.renderFloatingNotesModal();
    };

    const finish = () => {
      el.removeEventListener('transitionend', onEnd);
      note.updatedAt = Date.now();
      cleanup();
    };
    const onEnd = (event) => {
      if (event.target === el && event.propertyName === 'height') finish();
    };
    el.addEventListener('transitionend', onEnd);

    if (!wasMinimized) {
      const from = el.getBoundingClientRect().height;
      note.minimized = true;
      el.style.height = `${from}px`;
      el.offsetHeight;
      [body, meta].forEach((part) => {
        if (!part) return;
        part.style.opacity = '0';
        part.style.transform = 'translateY(-6px)';
      });
      el.style.height = `${collapsedHeight}px`;
      setTimeout(() => {
        if (el.classList.contains('animating-minimize')) finish();
      }, 310);
    } else {
      note.minimized = false;
      el.classList.remove('minimized');
      el.style.height = `${collapsedHeight}px`;
      [body, meta].forEach((part) => {
        if (!part) return;
        part.style.opacity = '0';
        part.style.transform = 'translateY(-6px)';
      });
      el.offsetHeight;
      el.style.height = `${expandedHeight}px`;
      requestAnimationFrame(() => {
        [body, meta].forEach((part) => {
          if (!part) return;
          part.style.opacity = '1';
          part.style.transform = 'translateY(0)';
        });
      });
      setTimeout(() => {
        if (el.classList.contains('animating-minimize')) finish();
      }, 330);
    }
  }

  startFloatingNoteDrag(event, noteEl) {
    if (!noteEl) return;
    const id = noteEl.dataset.noteId;
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    if (note.pinned) return;
    event.preventDefault();
    event.stopPropagation();
    this.bringFloatingNoteToFront(id, { render: false });
    const rect = noteEl.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let dragging = false;
    try { noteEl.setPointerCapture?.(pointerId); } catch {}
    const move = (moveEvent) => {
      if (pointerId != null && moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragging && Math.hypot(deltaX, deltaY) < 6) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add('moving-floating-note');
        noteEl.classList.add('is-dragging');
      }
      const next = this.clampFloatingNoteRect({
        ...note,
        x: rect.left + deltaX,
        y: rect.top + deltaY,
        width: rect.width,
        height: note.minimized ? note.height : rect.height,
      });
      noteEl.style.left = `${next.x}px`;
      noteEl.style.top = `${next.y}px`;
      Object.assign(note, { x: next.x, y: next.y });
    };
    const up = (upEvent) => {
      if (pointerId != null && upEvent.pointerId !== pointerId) return;
      document.body.classList.remove('moving-floating-note');
      noteEl.classList.remove('is-dragging');
      try { noteEl.releasePointerCapture?.(pointerId); } catch {}
      if (dragging) this.updateFloatingNote(id, { x: note.x, y: note.y }, { render: false, immediate: true });
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
    };
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
  }

  startFloatingNoteResize(event, noteEl) {
    if (!noteEl) return;
    const id = noteEl.dataset.noteId;
    const note = this.state.floatingNotes.find((item) => item.id === id);
    if (!note) return;
    if (note.pinned) return;
    event.preventDefault();
    this.bringFloatingNoteToFront(id, { render: false });
    const rect = noteEl.getBoundingClientRect();
    document.body.classList.add('resizing-floating-note');
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (moveEvent) => {
      const next = this.clampFloatingNoteRect({
        ...note,
        width: rect.width + moveEvent.clientX - startX,
        height: rect.height + moveEvent.clientY - startY,
      });
      noteEl.style.width = `${next.width}px`;
      noteEl.style.height = `${next.height}px`;
      Object.assign(note, { width: next.width, height: next.height });
    };
    const up = () => {
      document.body.classList.remove('resizing-floating-note');
      this.updateFloatingNote(id, { width: note.width, height: note.height }, { render: false, immediate: true });
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  clampFloatingNoteRect(note) {
    const minWidth = 240;
    const minHeight = 160;
    const mobile = this.isMobileLayout();
    const topReserve = mobile ? 70 : 8;
    const bottomReserve = mobile && !this.state.mobile.keyboardOpen && !this.state.mobile.editorFocused ? 104 : 18;
    const availableHeight = Math.max(minHeight, window.innerHeight - topReserve - bottomReserve);
    const width = Math.min(Math.max(Number(note.width) || 320, minWidth), Math.max(minWidth, window.innerWidth - 24));
    const height = Math.min(Math.max(Number(note.height) || 260, minHeight), availableHeight);
    const x = Math.min(Math.max(Number(note.x) || 0, mobile ? 8 : -width + 140), window.innerWidth - (mobile ? width + 8 : 80));
    const y = Math.min(Math.max(Number(note.y) || 0, topReserve), window.innerHeight - bottomReserve - Math.min(height, availableHeight));
    return { x, y, width, height };
  }

  saveCurrentNote() {
    const input = document.getElementById('notes-input');
    if (!input) return;
    
    // Sync interactive HTML back to markdown
    let lines = [];
    input.childNodes.forEach(node => {
      const cb = node.querySelector?.('input[type="checkbox"]');
      if (cb) {
        lines.push(`- [${cb.checked ? 'x' : ' '}] ${node.textContent.trim()}`);
      } else {
        lines.push(node.textContent || '');
      }
    });
    const result = lines.join('\n');
    
    if (this.state.noteMode === 'global') {
      this.state.globalNotes = result;
      if (this.state.settings.e2e) safeRemoveStorageItem(localStorage, 'nocturne-global-notes');
      else safeSetStorageItem(localStorage, 'nocturne-global-notes', result);
    } else {
      const doc = this.activeDoc;
      if (!doc) return;
      doc.notes = result;
      doc.updatedAt = Date.now();
      this.writeLiveDraft(doc.id);
      this.saveDocByIdDebounced(doc.id);
    }
  }

  dictionarySettingsContent() {
    const filter = this.state.dictionaryFilter || 'all';
    const search = (this.state.dictionarySearch || '').trim().toLowerCase();
    const disabledBuiltins = new Set(this.state.typoRules.filter((rule) => rule.source === 'disabled-builtin').map((rule) => rule.builtinKey));
    const overrides = new Map(this.state.typoRules.filter((rule) => rule.source === 'override').map((rule) => [rule.builtinKey, rule]));
    const userRules = this.state.typoRules.filter((rule) => rule.source === 'user');
    const builtinCards = Object.entries(TYPO_LOOKUP).map(([key, rule]) => ({
      id: `builtin-${key}`,
      builtinKey: key,
      wrong: rule.wrong || key,
      correct: overrides.get(key)?.correct || rule.correct || '',
      label: overrides.get(key)?.label || rule.label || 'Частая ошибка',
      source: disabledBuiltins.has(key) ? 'disabled' : overrides.has(key) ? 'override' : 'builtin',
      userRuleId: overrides.get(key)?.id || null,
    }));
    const userCards = userRules.map((rule) => ({ ...rule, source: 'user', userRuleId: rule.id }));
    let cards = [...userCards, ...builtinCards];
    if (filter === 'mine') cards = cards.filter((rule) => rule.source === 'user');
    if (filter === 'builtin') cards = cards.filter((rule) => rule.source === 'builtin');
    if (filter === 'disabled') cards = cards.filter((rule) => rule.source === 'disabled');
    if (filter === 'override') cards = cards.filter((rule) => rule.source === 'override');
    if (search) cards = cards.filter((rule) => `${rule.wrong} ${rule.correct} ${rule.label}`.toLowerCase().includes(search));
    const badge = (source) => ({
      user: 'Моё',
      builtin: 'Встроенное',
      disabled: 'Отключено',
      override: 'Переопределено',
    }[source] || source);
    const actions = (rule) => {
      if (rule.source === 'user') {
        return `<button data-action="dictionary-edit" data-rule-id="${rule.id}">Редактировать</button><button data-action="dictionary-delete" data-rule-id="${rule.id}">Удалить</button>`;
      }
      if (rule.source === 'disabled') return `<button data-action="dictionary-enable-builtin" data-builtin-key="${rule.builtinKey}">Включить</button>`;
      if (rule.source === 'override') return `<button data-action="dictionary-edit" data-rule-id="${rule.userRuleId}">Редактировать</button><button data-action="dictionary-reset-override" data-builtin-key="${rule.builtinKey}">Сбросить override</button>`;
      return `<button data-action="dictionary-override" data-builtin-key="${rule.builtinKey}">Переопределить</button><button data-action="dictionary-disable-builtin" data-builtin-key="${rule.builtinKey}">Отключить</button>`;
    };
    return `
      <div class="tab-content active dictionary-settings">
        <section class="dictionary-hero">
          <div>
            <h3>Словарь частых ошибок</h3>
            <p>Локальные правила проверки текста. Встроенную базу можно дополнять, отключать и переопределять под ваш проект.</p>
          </div>
          <button class="pill-btn ai-btn" data-action="dictionary-add"><i class="bx bx-plus"></i> Добавить правило</button>
        </section>
        <section class="dictionary-controls">
          <div class="dictionary-control-row">
            <label class="dictionary-toggle"><span>Проверка частых ошибок</span><div class="toggle ${this.state.settings.strictSpellcheck ? 'on' : ''}" data-setting="strictSpellcheck" data-kind="toggle"></div></label>
            <label class="dictionary-toggle smart-dictionary-toggle"><span>Smart-словарь <em>Экспериментально</em></span><div class="toggle ${this.state.settings.smartDictionary ? 'on' : ''}" data-setting="smartDictionary" data-kind="toggle"></div></label>
            <div class="dictionary-search">
              <i class="bx bx-search"></i>
              <input class="form-control" data-dictionary-search placeholder="Поиск правил..." value="${escapeHtml(this.state.dictionarySearch || '')}">
            </div>
          </div>
          <div class="dictionary-filters">
            ${[['all', 'Все'], ['mine', 'Мои'], ['builtin', 'Встроенные'], ['disabled', 'Отключённые'], ['override', 'Переопределённые']].map(([id, label]) => `<button class="${filter === id ? 'active' : ''}" data-dictionary-filter="${id}">${label}</button>`).join('')}
          </div>
        </section>
        <div class="dictionary-list">
          ${cards.slice(0, 180).map((rule) => `<article class="dictionary-card ${rule.source}">
            <div class="dictionary-rule-main">
              <div class="dictionary-rule-text"><strong>${escapeHtml(rule.wrong)}</strong><i class="bx bx-right-arrow-alt"></i><span>${escapeHtml(rule.correct)}</span></div>
              <small>${escapeHtml(rule.label)} · ${badge(rule.source)}</small>
            </div>
            <div class="dictionary-card-actions">${actions(rule)}</div>
          </article>`).join('') || '<div class="muted-empty">Правила не найдены.</div>'}
        </div>
      </div>
    `;
  }

  updateDictionaryList() {
    const current = document.querySelector('.dictionary-list');
    if (!current) return;
    const next = document.createElement('div');
    next.innerHTML = this.dictionarySettingsContent();
    const nextList = next.querySelector('.dictionary-list');
    if (!nextList) return;
    clearTimeout(this.dictionaryListTimer);
    const currentHeight = current.getBoundingClientRect().height;
    if (currentHeight) current.style.height = `${Math.round(currentHeight)}px`;
    current.classList.remove('is-entering');
    current.classList.add('is-leaving');
    this.dictionaryListTimer = window.setTimeout(() => {
      current.innerHTML = nextList.innerHTML;
      current.scrollTop = 0;
      current.classList.remove('is-leaving');
      current.classList.add('is-entering');
      this.dictionaryListTimer = window.setTimeout(() => {
        current.classList.remove('is-entering');
        current.style.height = '';
      }, 150);
    }, 90);
  }

  updateDictionarySearchList() {
    const current = document.querySelector('.dictionary-list');
    if (!current) return;
    const next = document.createElement('div');
    next.innerHTML = this.dictionarySettingsContent();
    const nextList = next.querySelector('.dictionary-list');
    if (!nextList) return;
    current.innerHTML = nextList.innerHTML;
    window.setTimeout(() => {
      current.style.minHeight = '';
    }, 0);
  }

  updateDictionaryFilter(filter) {
    this.state.dictionaryFilter = filter;
    document.querySelectorAll('[data-dictionary-filter]').forEach((button) => {
      button.classList.toggle('active', button.dataset.dictionaryFilter === filter);
    });
    this.updateDictionaryList();
  }

  reviewSettingsContent() {
    const mode = this.state.reviewMode || 'write';
    const modeCard = (id, title, text, icon) => `<button class="review-mode-card ${mode === id ? 'active' : ''}" data-review-mode="${id}">
      <i class="bx ${icon}"></i>
      <strong>${title}</strong>
      <span>${text}</span>
    </button>`;
    return `
      <div class="tab-content active review-settings">
        <div class="dictionary-header">
          <div>
            <h3>Режимы работы и редактура</h3>
            <p>Выберите, как документ ведёт себя сейчас: свободное письмо, редакторская разметка или финальная обработка правок.</p>
          </div>
        </div>
        <div class="review-mode-grid">
          ${modeCard('write', 'Письмо', 'Обычное редактирование текста.', 'bx-pen')}
          ${modeCard('editor', 'Редактор', 'Текст защищён, доступны комментарии, пометки и предложения.', 'bx-comment-edit')}
          ${modeCard('finalization', 'Финализация', 'Текст редактируется, видны правки и навигация по ним.', 'bx-check-double')}
        </div>
        <div class="setting-row">
          <div class="setting-info"><span>Экспортировать .nocturned рядом с DOCX</span><small>Если у документа есть редакторские правки, рядом с DOCX скачивается JSON-файл обмена правками.</small></div>
          <div class="setting-control"><div class="toggle ${this.state.exportNocturned ? 'on' : ''}" data-action="toggle-nocturned-export"></div></div>
        </div>
      </div>
    `;
  }

  demoDocId(id) {
    return `demo-${id}`;
  }

  demoLoreId(id) {
    return `demo-${id}`;
  }

  cloneDemoDoc(source) {
    const now = Date.now();
    const doc = structuredClone(source);
    return {
      ...doc,
      id: this.demoDocId(source.id),
      isDemo: true,
      demoGroup: 'docs',
      createdAt: now,
      updatedAt: now,
      ast: {
        type: 'doc',
        blocks: (doc.ast?.blocks || []).map((block, index) => ({ ...block, id: `demo-${source.id}-block-${index}` })),
      },
    };
  }

  cloneDemoLoreItem(source, group) {
    const docIds = new Set(this.state.docs.map((doc) => doc.id));
    const mappedDocs = (source.documentIds || [])
      .map((id) => this.demoDocId(id))
      .filter((id) => docIds.has(id));
    return {
      ...structuredClone(source),
      id: this.demoLoreId(source.id),
      isDemo: true,
      demoGroup: group,
      documentIds: mappedDocs,
    };
  }

  cloneDemoTimelineEvent(source) {
    const event = this.cloneDemoLoreItem(source, 'timeline');
    event.subEvents = (source.subEvents || []).map((subEvent, index) => ({
      ...structuredClone(subEvent),
      id: this.demoLoreId(subEvent.id || `${source.id}-sub-${index}`),
      isDemo: true,
      demoGroup: 'timeline',
      order: Number.isFinite(Number(subEvent.order)) ? Number(subEvent.order) : index,
    }));
    return event;
  }

  async ensureDefaultFolders() {
    const existing = new Set(this.state.folders.map((folder) => folder.id));
    const missing = seedFolders.filter((folder) => !existing.has(folder.id)).map((folder) => structuredClone(folder));
    if (!missing.length) return;
    this.state.folders.push(...missing);
    this.state.folders.sort((a, b) => a.order - b.order);
    await Promise.all(missing.map((folder) => this.db.put('folders', folder)));
  }

  async addDemoDocs(options = {}) {
    await this.ensureDefaultFolders();
    const existing = new Set(this.state.docs.map((doc) => doc.id));
    const docs = seedDocs.map((doc) => this.cloneDemoDoc(doc)).filter((doc) => !existing.has(doc.id));
    if (!docs.length) {
      if (!options.silent) this.toast('Тестовые главы уже добавлены.');
      return;
    }
    this.state.docs.push(...docs);
    await Promise.all(docs.map((doc) => this.db.put('docs', doc)));
    if (!this.state.activeDocId) this.state.activeDocId = docs[0].id;
    if (this.getPane('primary')?.type === 'document' && !this.getPane('primary')?.docId) this.state.workspace.panes.primary.docId = this.state.activeDocId;
    this.persistWorkspaceState();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Добавлено тестовых глав: ${docs.length}`);
    }
  }

  async removeDemoDocs(options = {}) {
    const demoDocs = this.state.docs.filter((doc) => doc.isDemo && doc.demoGroup === 'docs');
    const ids = new Set(demoDocs.map((doc) => doc.id));
    if (!ids.size) {
      if (!options.silent) this.toast('Тестовых глав нет.');
      return;
    }
    const demoMarks = this.state.reviewMarks.filter((mark) => ids.has(mark.docId));
    const demoNotes = this.state.floatingNotes.filter((note) => note.scope === 'document' && ids.has(note.linkedId));
    await Promise.all([
      ...demoDocs.map((doc) => this.db.delete('docs', doc.id)),
      ...demoMarks.map((mark) => this.db.delete('reviewMarks', mark.id)),
      ...demoNotes.filter((note) => !note.temporary).map((note) => this.db.delete('floatingNotes', note.id)),
    ]);
    demoDocs.forEach((doc) => safeRemoveStorageItem(localStorage, `${LIVE_PREFIX}${doc.id}`));
    this.state.docs = this.state.docs.filter((doc) => !ids.has(doc.id));
    this.state.reviewMarks = this.state.reviewMarks.filter((mark) => !ids.has(mark.docId));
    this.state.floatingNotes = this.state.floatingNotes.filter((note) => !(note.scope === 'document' && ids.has(note.linkedId)));
    if (ids.has(this.state.activeDocId)) this.state.activeDocId = this.state.docs[0]?.id || null;
    Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
      if (pane.type === 'document' && ids.has(pane.docId)) {
        Object.assign(pane, this.emptyPaneDescriptor(pane.id));
      }
    });
        this.persistWorkspaceState();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Удалено тестовых глав: ${ids.size}`);
    }
  }

  async addDemoLore(options = {}) {
    const addItems = (type, items) => {
      const existing = new Set(this.state.lore[type].map((item) => item.id));
      const next = items.map((item) => this.cloneDemoLoreItem(item, 'lore')).filter((item) => !existing.has(item.id));
      this.state.lore[type].push(...next);
      return next.length;
    };
    const count = addItems('characters', seedLore.characters || []) + addItems('locations', seedLore.locations || []);
    if (!count) {
      if (!options.silent) this.toast('Тестовые персонажи и места уже добавлены.');
      return;
    }
    await this.saveLore();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Добавлено демо-элементов Базы знаний: ${count}`);
    }
  }

  async removeDemoLore(options = {}) {
    const doomedCharacterIds = new Set(this.state.lore.characters.filter((item) => item.isDemo && item.demoGroup === 'lore').map((item) => item.id));
    const doomedLocationIds = new Set(this.state.lore.locations.filter((item) => item.isDemo && item.demoGroup === 'lore').map((item) => item.id));
    const count = doomedCharacterIds.size + doomedLocationIds.size;
    if (!count) {
      if (!options.silent) this.toast('Тестовых персонажей и мест нет.');
      return;
    }
    const demoNotes = this.state.floatingNotes.filter((note) => (
      (note.scope === 'character' && doomedCharacterIds.has(note.linkedId))
      || (note.scope === 'location' && doomedLocationIds.has(note.linkedId))
    ));
    await Promise.all(demoNotes.filter((note) => !note.temporary).map((note) => this.db.delete('floatingNotes', note.id)));
    this.state.floatingNotes = this.state.floatingNotes.filter((note) => !demoNotes.includes(note));
    this.state.lore.characters = this.state.lore.characters.filter((item) => !doomedCharacterIds.has(item.id));
    this.state.lore.locations = this.state.lore.locations.filter((item) => !doomedLocationIds.has(item.id));
    if (this.state.activeLoreDetail && (
      doomedCharacterIds.has(this.state.activeLoreDetail.id) || doomedLocationIds.has(this.state.activeLoreDetail.id)
    )) this.state.activeLoreDetail = null;
    await this.saveLore();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Удалено демо-элементов Базы знаний: ${count}`);
    }
  }

  async addDemoTimeline(options = {}) {
    const existing = new Set(this.state.lore.timeline.map((item) => item.id));
    const events = (seedLore.timeline || []).map((event) => this.cloneDemoTimelineEvent(event)).filter((event) => !existing.has(event.id));
    if (!events.length) {
      if (!options.silent) this.toast('Тестовые события таймлайна уже добавлены.');
      return;
    }
    this.state.lore.timeline.push(...events);
    await this.saveLore();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Добавлено тестовых событий: ${events.length}`);
    }
  }

  async removeDemoTimeline(options = {}) {
    const doomedIds = new Set(this.state.lore.timeline.filter((item) => item.isDemo && item.demoGroup === 'timeline').map((item) => item.id));
    let removedSubevents = 0;
    this.state.lore.timeline.forEach((event) => {
      const before = event.subEvents?.length || 0;
      event.subEvents = (event.subEvents || []).filter((subEvent) => !(subEvent.isDemo && subEvent.demoGroup === 'timeline'));
      removedSubevents += before - event.subEvents.length;
    });
    if (!doomedIds.size && !removedSubevents) {
      if (!options.silent) this.toast('Тестовых событий таймлайна нет.');
      return;
    }
    this.state.lore.timeline = this.state.lore.timeline.filter((item) => !doomedIds.has(item.id));
    if (doomedIds.has(this.state.activeSubtimelineId)) this.state.activeSubtimelineId = null;
    await this.saveLore();
    if (!options.silent) {
      this.renderAll();
      this.toast(`Удалено тестовых событий: ${doomedIds.size + removedSubevents}`);
    }
  }

  async addFullDemoSet() {
    await this.addDemoDocs({ silent: true });
    await this.addDemoLore({ silent: true });
    await this.addDemoTimeline({ silent: true });
    this.renderAll();
    this.toast('Весь демо-набор добавлен.');
  }

  confirmDialog({ title, message, confirmText = 'Подтвердить', icon = 'bx-help-circle', danger = true } = {}) {
    return new Promise((resolve) => {
      const overlay = document.getElementById('form-overlay');
      overlay.innerHTML = `
        <div class="form-modal confirm-modal">
          <div class="confirm-icon"><i class="bx ${escapeHtml(icon)}"></i></div>
          <h2>${escapeHtml(title || 'Подтвердить действие')}</h2>
          <p>${escapeHtml(message || '')}</p>
          <div class="form-actions">
            <button class="pill-btn" data-close-form>Отмена</button>
            <button class="pill-btn ${danger ? 'danger-btn' : 'ai-btn'}" data-confirm-dialog>${escapeHtml(confirmText)}</button>
          </div>
        </div>`;
      overlay.classList.add('active');
      const close = (value) => {
        overlay.classList.remove('active');
        resolve(value);
      };
      overlay.querySelector('[data-close-form]').onclick = () => close(false);
      overlay.querySelector('[data-confirm-dialog]').onclick = () => close(true);
    });
  }

  async removeFullDemoSet() {
    if (!await this.confirmDialog({ title: 'Удалить демо-контент?', message: 'Пользовательские данные не будут затронуты.', confirmText: 'Удалить', icon: 'bx-trash' })) return;
    await this.removeDemoDocs({ silent: true });
    await this.removeDemoLore({ silent: true });
    await this.removeDemoTimeline({ silent: true });
    this.renderAll();
    this.toast('Демо-набор удален.');
  }

  async clearTemporaryNotes() {
    const count = this.state.floatingNotes.filter((note) => note.temporary).length;
    if (!count) {
      this.toast('Временных заметок нет.');
      return;
    }
    this.state.floatingNotes = this.state.floatingNotes.filter((note) => !note.temporary);
    this.renderFloatingNotes();
    this.renderFloatingNotesModal();
    this.renderSettings();
    this.toast(`Удалено временных заметок: ${count}`);
  }

  async clearCurrentDocumentReviewMarks() {
    const doc = this.getFocusedDoc();
    if (!doc) {
      this.toast('Нет активного документа.');
      return;
    }
    const marks = this.state.reviewMarks.filter((mark) => mark.docId === doc.id);
    if (!marks.length) {
      this.toast('У текущего документа нет правок.');
      return;
    }
    if (!await this.confirmDialog({ title: 'Удалить редакторские правки?', message: `Документ: ${doc.title}`, confirmText: 'Удалить', icon: 'bx-message-x' })) return;
    await Promise.all(marks.map((mark) => this.db.delete('reviewMarks', mark.id)));
    this.state.reviewMarks = this.state.reviewMarks.filter((mark) => mark.docId !== doc.id);
    this.renderAll();
    this.toast(`Удалено правок: ${marks.length}`);
  }

  async resetHiddenFloatingNotes() {
    const hidden = this.state.floatingNotes.filter((note) => note.hidden && !note.temporary);
    if (!hidden.length) {
      this.toast('Скрытых постоянных заметок нет.');
      return;
    }
    hidden.forEach((note) => {
      note.hidden = false;
      note.forceVisible = true;
      note.updatedAt = Date.now();
    });
    await Promise.all(hidden.map((note) => this.db.put('floatingNotes', { ...note, forceVisible: false })));
    this.renderFloatingNotes();
    this.renderSettings();
    this.toast(`Показано окон заметок: ${hidden.length}`);
  }

  timelineEventCount(events = this.state.lore.timeline) {
    return (events || []).reduce((sum, event) => sum + 1 + this.timelineEventCount(event.subEvents || []), 0);
  }

  storageApproxBytes() {
    const localBytes = Object.entries(localStorage).reduce((sum, [key, value]) => sum + (key.length + String(value).length) * 2, 0);
    const stateBytes = JSON.stringify({
      docs: this.state.docs,
      lore: this.state.lore,
      floatingNotes: this.state.floatingNotes.filter((note) => !note.temporary),
      reviewMarks: this.state.reviewMarks,
      settings: this.state.settings,
    }).length * 2;
    return localBytes + stateBytes;
  }

  formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  miscSettingsContent() {
    const demoDocs = this.state.docs.filter((doc) => doc.isDemo && doc.demoGroup === 'docs').length;
    const demoLore = this.state.lore.characters.filter((item) => item.isDemo && item.demoGroup === 'lore').length
      + this.state.lore.locations.filter((item) => item.isDemo && item.demoGroup === 'lore').length;
    const demoTimeline = this.state.lore.timeline.filter((item) => item.isDemo && item.demoGroup === 'timeline').length;
    const diagnostics = [
      ['Документы', this.state.docs.length],
      ['Персонажи', this.state.lore.characters.length],
      ['Локации', this.state.lore.locations.length],
      ['События', this.timelineEventCount()],
      ['Заметки', this.state.floatingNotes.length],
      ['Review marks', this.state.reviewMarks.length],
      ['Локальное хранилище', this.formatBytes(this.storageApproxBytes())],
    ];
    const action = (icon, label, dataAction, danger = false) => `<button class="pill-btn ${danger ? 'danger-btn' : ''}" data-action="${dataAction}"><i class="bx ${icon}"></i> ${label}</button>`;
    return `
      <div class="tab-content active misc-settings">
        <p class="settings-section-note">Сервисные, тестовые и редкие функции.</p>
        <section class="misc-card">
          <div class="misc-card-head">
            <div>
              <h3>Демо-контент</h3>
              <p>Тестовые элементы создаются с маркировкой <code>isDemo</code> и удаляются только по этой маркировке.</p>
            </div>
            <span class="misc-chip">${demoDocs} глав · ${demoLore} БЗ · ${demoTimeline} событий</span>
          </div>
          <div class="misc-action-grid">
            ${action('bx-file-plus', 'Добавить тестовые главы', 'demo-add-docs')}
            ${action('bx-trash', 'Удалить тестовые главы', 'demo-remove-docs', true)}
            ${action('bx-user-plus', 'Добавить тестовых персонажей и места', 'demo-add-lore')}
            ${action('bx-trash', 'Удалить тестовых персонажей и места', 'demo-remove-lore', true)}
            ${action('bx-git-commit', 'Добавить тестовые события таймлайна', 'demo-add-timeline')}
            ${action('bx-trash', 'Удалить тестовые события таймлайна', 'demo-remove-timeline', true)}
            ${action('bx-layer-plus', 'Добавить весь демо-набор', 'demo-add-all')}
            ${action('bx-trash', 'Удалить весь демо-набор', 'demo-remove-all', true)}
          </div>
        </section>
        <section class="misc-card misc-dev-card">
          <div class="misc-card-head">
            <div>
              <h3>Сервисные действия</h3>
              <p>Отладка и обслуживание. Блок можно удалить целиком без зависимости от демо-контента.</p>
            </div>
          </div>
          <div class="misc-action-grid compact">
            ${action('bx-eraser', 'Очистить временные заметки', 'clear-temp-notes', true)}
            ${action('bx-comment-x', 'Очистить редакторские правки текущего документа', 'clear-current-review-marks', true)}
            ${action('bx-show', 'Сбросить скрытые окна заметок', 'reset-hidden-floating-notes')}
          </div>
        </section>
        <section class="misc-card">
          <div class="misc-card-head">
            <div>
              <h3>Диагностика</h3>
              <p>Краткое состояние локального проекта без отправки данных наружу.</p>
            </div>
          </div>
          <div class="diagnostics-grid">
            ${diagnostics.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
          </div>
        </section>
      <div class="setting-row">
        <div class="setting-info">
          <span>Экспериментальный дизайн</span>
          <small>Включает ультра-хайповый детализированный UI (Парящие панели, 3D, живой фон).</small>
        </div>
        <div class="setting-control">
          <div class="toggle ${this.state.settings.experimentalDesign ? 'on' : ''}" data-setting="experimentalDesign" data-kind="toggle"></div>
        </div>
      </div>
</div>
    `;
  }

  openTypoRuleForm(seedText = '', existing = null, options = {}) {
    this.closeAllFloatingMenus();
    const wrong = existing?.wrong || String(seedText || '').trim().replace(/\s+/g, ' ');
    if ((!wrong && !options.allowBlank) || wrong.length > 120) {
      this.toast('Выделение слишком длинное для правила словаря.');
      return;
    }
    const normalized = normalizeTypoToken(wrong);
    const builtin = wrong ? TYPO_LOOKUP[normalized] : null;
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal typo-rule-modal">
        <h2>${existing ? 'Редактировать правило' : 'Добавить правило в словарь'}</h2>
        <div class="form-grid">
          <label>Неверное написание<input class="form-control" id="typo-wrong" value="${escapeHtml(wrong)}"></label>
          <label>Правильный вариант<input class="form-control" id="typo-correct" value="${escapeHtml(existing?.correct || builtin?.correct || '')}"></label>
          <label>Метка<select class="modal-select" id="typo-label">
            ${['Мой словарь', 'Частая ошибка', 'Опечатка', 'Раздельно / слитно'].map((label) => `<option ${label === (existing?.label || 'Мой словарь') ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
          <label>Режим<select class="modal-select" id="typo-mode">
            <option value="token" ${!/\s/u.test(wrong) ? 'selected' : ''}>token</option>
            <option value="phrase" ${/\s/u.test(wrong) ? 'selected' : ''}>phrase</option>
          </select></label>
        </div>
        ${builtin && !existing ? '<p class="form-helper">Для встроенного правила будет создано пользовательское переопределение.</p>' : ''}
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" id="save-typo-rule">Сохранить правило</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('#save-typo-rule').onclick = async () => {
      const nextWrong = overlay.querySelector('#typo-wrong').value.trim().replace(/\s+/g, ' ');
      const correct = overlay.querySelector('#typo-correct').value.trim();
      if (!nextWrong || !correct) {
        this.toast('Заполните неверное и правильное написание.');
        return;
      }
      const normalizedWrong = normalizeTypoToken(nextWrong);
      const nextBuiltin = TYPO_LOOKUP[normalizedWrong];
      await this.saveTypoRule({
        id: existing?.id || uid('typo-rule'),
        wrong: nextWrong,
        normalizedWrong,
        correct,
        label: overlay.querySelector('#typo-label').value,
        enabled: true,
        source: existing?.source === 'override' || nextBuiltin ? 'override' : 'user',
        matchMode: overlay.querySelector('#typo-mode').value,
        builtinKey: nextBuiltin ? normalizedWrong : existing?.builtinKey || null,
        createdAt: existing?.createdAt || Date.now(),
      });
      overlay.classList.remove('active');
      this.closeContextMenu();
      this.toast('Правило добавлено в словарь.');
    };
  }

  handleDictionaryAction(action, event) {
    if (!action?.startsWith?.('dictionary-')) return false;
    const target = event.target.closest('[data-rule-id], [data-builtin-key], [data-dictionary-filter], [data-action]');
    if (action === 'dictionary-add') this.openTypoRuleForm('', null, { allowBlank: true });
    if (action === 'dictionary-edit') {
      const rule = this.state.typoRules.find((item) => item.id === target?.dataset.ruleId);
      if (rule) this.openTypoRuleForm(rule.wrong, rule);
    }
    if (action === 'dictionary-delete' && target?.dataset.ruleId) this.deleteTypoRule(target.dataset.ruleId);
    if (action === 'dictionary-disable-builtin') {
      const key = target?.dataset.builtinKey;
      const builtin = TYPO_LOOKUP[key];
      if (key && builtin) this.saveTypoRule({ wrong: builtin.wrong || key, normalizedWrong: key, correct: builtin.correct || '', label: builtin.label || 'Отключено', source: 'disabled-builtin', builtinKey: key, enabled: true });
    }
    if (action === 'dictionary-enable-builtin') {
      const rule = this.state.typoRules.find((item) => item.source === 'disabled-builtin' && item.builtinKey === target?.dataset.builtinKey);
      if (rule) this.deleteTypoRule(rule.id);
    }
    if (action === 'dictionary-override') {
      const key = target?.dataset.builtinKey;
      const builtin = TYPO_LOOKUP[key];
      if (builtin) this.openTypoRuleForm(builtin.wrong || key, { id: uid('typo-rule'), wrong: builtin.wrong || key, normalizedWrong: key, correct: builtin.correct || '', label: builtin.label || 'Частая ошибка', source: 'override', builtinKey: key, matchMode: /\s/u.test(builtin.wrong || key) ? 'phrase' : 'token' });
    }
    if (action === 'dictionary-reset-override') {
      this.state.typoRules
        .filter((item) => item.source === 'override' && item.builtinKey === target?.dataset.builtinKey)
        .forEach((rule) => this.deleteTypoRule(rule.id));
    }
    return true;
  }

  insertNoteSnippet(value) {
    const input = document.getElementById('notes-input');
    if (!input) return;
    input.focus();
    const sel = getSelection();
    let range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || !input.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
    }
    range.deleteContents();
    const text = document.createTextNode(value);
    range.insertNode(text);
    range.setStart(text, text.length);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  toggleNoteChecklist() {
    const input = document.getElementById('notes-input');
    if (!input) return;
    const sel = getSelection();
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const line = (range?.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer : range?.commonAncestorContainer.parentElement)?.closest?.('.cb-line');
    if (line?.querySelector('input[type="checkbox"]')) {
      const cb = line.querySelector('input[type="checkbox"]');
      cb.checked = !cb.checked;
    } else {
      this.insertNoteSnippet('- [ ] ');
      return;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  renderGoal() {
    const today = new Date().toISOString().slice(0, 10);
    const cached = this.todayStatsCache?.id === today ? this.todayStatsCache.words : 0;
    const words = cached || Number(this.todayStatsCache?.words || 0);
    const goal = Number(this.state.settings.dailyGoal) || 1;
    const countEl = document.getElementById('goal-count');
    const fillEl = document.getElementById('goal-fill');
    if (!countEl || !fillEl) return;
    countEl.textContent = `${words} / ${goal}`;
    const pct = Math.min(100, Math.round((words / goal) * 100));
    fillEl.style.width = `${pct}%`;
    if (pct >= 100 && !safeGetStorageItem(localStorage, `goal-done-${new Date().toISOString().slice(0, 10)}`, '')) {
      safeSetStorageItem(localStorage, `goal-done-${new Date().toISOString().slice(0, 10)}`, '1');
      this.confetti();
      this.toast('Цель дня достигнута.');
    }
  }

  async updateTodayStats(docId = this.getFocusedDoc()?.id || null) {
    return this.updateTodayStatsForDoc(docId);
  }

  async updateTodayStatsForDoc(docId) {
    const id = new Date().toISOString().slice(0, 10);
    const doc = this.state.docs.find((item) => item.id === docId);
    const current = doc ? countWords(docText(doc.ast)) : 0;
    const previous = this.docWordBaselines.has(docId) ? this.docWordBaselines.get(docId) : current;
    const delta = Math.max(0, current - previous);
    this.docWordBaselines.set(docId, current);
    const existing = (await this.db.get('stats', id)) || { id, words: 0 };
    const next = { id, words: Math.max(0, Number(existing.words || 0) + delta), updatedAt: Date.now() };
    await this.db.put('stats', next);
    this.todayStatsCache = next;
    this.renderGoal();
  }

  smartPunctuationKey(event) {
    if (event.isComposing) return;
    const sel = getSelection();
    if (!sel.rangeCount || !sel.anchorNode || !sel.getRangeAt(0).collapsed) return;
    const text = sel.anchorNode.textContent || '';
    const offset = sel.anchorOffset;
    if (event.key === '-' && text[offset - 1] === '-') {
      event.preventDefault();
      this.replaceTextBeforeCaret(1, '—');
    }
    if (event.key === '.' && text.slice(Math.max(0, offset - 2), offset) === '..') {
      event.preventDefault();
      this.replaceTextBeforeCaret(2, '…');
    }
  }

  replaceTextBeforeCaret(count, replacement) {
    const activeEditable = document.activeElement?.closest?.('.page-content');
    const editor = this.nocturneEditor?.getByElement(activeEditable);
    if (editor) {
      const { from, to } = editor.state.selection;
      if (from !== to) return false;
      const start = Math.max(0, from - count);
      return editor.chain().focus().deleteRange({ from: start, to: from }).insertContent(replacement).run();
    }
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return false;
    try {
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const node = range.startContainer;
        if (range.startOffset >= count) {
          const replaceRange = document.createRange();
          replaceRange.setStart(node, range.startOffset - count);
          replaceRange.setEnd(node, range.startOffset);
          sel.removeAllRanges();
          sel.addRange(replaceRange);
          document.execCommand('insertText', false, replacement);
          return true;
        }
      }
      for (let i = 0; i < count; i++) {
        document.execCommand('delete', false, null);
      }
      document.execCommand('insertText', false, replacement);
      return true;
    } catch (e) {
      console.error(e);
      try {
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          const node = range.startContainer;
          const start = Math.max(0, range.startOffset - count);
          node.nodeValue = `${node.nodeValue.slice(0, start)}${replacement}${node.nodeValue.slice(range.startOffset)}`;
          const next = document.createRange();
          next.setStart(node, start + replacement.length);
          next.collapse(true);
          sel.removeAllRanges();
          sel.addRange(next);
        } else {
          const textNode = document.createTextNode(replacement);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
        const editable = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
        editable?.closest?.('.page-content')?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: replacement }));
        return true;
      } catch (err) {
        console.error(err);
        return false;
      }
    }
  }

  updateCursorLight(editable = document.activeElement?.closest('.page-content')) {
    const selection = getSelection();
    if (!selection.rangeCount || !editable) return;
    const page = editable.closest('.page');
    const light = page?.querySelector('.cursor-light');
    if (!light) return;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = this.rangeRect(range);
    if (!rect) return;
    const pageRect = page.getBoundingClientRect();
    if (document.body.classList.contains('theme-experimental')) {
      light.style.left = `${rect.left - pageRect.left}px`;
      light.style.top = `${rect.top - pageRect.top + rect.height / 2}px`;
    } else {
      light.style.left = `${rect.left - pageRect.left - 17}px`;
      light.style.top = `${rect.top - pageRect.top - 9}px`;
    }
  }

  rangeRect(range) {
    const softEmptyLineRect = this.softEmptyLineCaretRect(range);
    if (softEmptyLineRect) return softEmptyLineRect;
    const emptyBlockRect = this.emptyBlockCaretRect(range);
    if (emptyBlockRect) return emptyBlockRect;
    const directRect = range.getBoundingClientRect();
    if (directRect && (directRect.width || directRect.height)) return directRect;
    return this.caretRectFromContext(range);
  }

  softEmptyLineCaretRect(range) {
    if (!range.collapsed || !this.softEmptyLine) return null;
    const editable = document.activeElement?.closest?.('.page-content');
    if (!editable) return null;
    const node = range.startContainer;
    const block = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('[data-block-id]');
    if (!block || !editable.contains(block) || block.dataset.blockId !== this.softEmptyLine.blockId) return null;
    const caretOffset = this.caretOffsetInBlock(block, range);
    if (!this.isCaretOnSoftEmptyLine(block, caretOffset)) return null;

    const styles = getComputedStyle(block);
    const lineHeight = Number.parseFloat(styles.lineHeight) || this.state.settings.fontSize * this.state.settings.lineHeight;
    const blockRect = block.getBoundingClientRect();
    const align = styles.textAlign || 'left';
    let leftOffset = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.textIndent) || 0);
    if (align === 'center') {
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
      leftOffset = (blockRect.width - paddingLeft - paddingRight) / 2 + paddingLeft;
    } else if (align === 'right' || align === 'end') {
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      leftOffset = blockRect.width - paddingRight;
    }
    const left = blockRect.left + leftOffset;
    const previousPosition = this.blockTextPosition(block, Math.max(0, this.softEmptyLine.offset - 1));
    const previousRect = previousPosition ? this.textCaretRect(previousPosition.node, previousPosition.offset) : null;
    const top = previousRect ? previousRect.top + lineHeight : blockRect.top + lineHeight;
    return this.rectLike(left, top, lineHeight);
  }

  caretRectFromContext(range) {
    if (!range.collapsed) return null;
    const editable = document.activeElement?.closest?.('.page-content');
    if (!editable) return null;
    const node = range.startContainer;
    const block = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('[data-block-id]');
    if (!block || !editable.contains(block)) return null;
    const styles = getComputedStyle(block);
    const lineHeight = Number.parseFloat(styles.lineHeight) || this.state.settings.fontSize * this.state.settings.lineHeight;
    const blockRect = block.getBoundingClientRect();
    const blockLeft = blockRect.left + (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.textIndent) || 0);

    if (node.nodeType === Node.TEXT_NODE) {
      const rect = this.textCaretRect(node, range.startOffset);
      if (rect) return rect;
    }

    const children = node.nodeType === Node.ELEMENT_NODE ? [...node.childNodes] : [];
    const previous = children[range.startOffset - 1] || null;
    const next = children[range.startOffset] || null;
    const nextRect = this.nodeStartRect(next);
    if (nextRect) return this.rectLike(nextRect.left, nextRect.top, nextRect.height || lineHeight);

    const previousRect = this.nodeEndRect(previous);
    if (previousRect) {
      if (previous?.nodeType === Node.ELEMENT_NODE && previous.tagName === 'BR') {
        const beforeBreakRect = this.previousContentRect(previous);
        const top = beforeBreakRect ? beforeBreakRect.top + lineHeight : blockRect.top;
        return this.rectLike(blockLeft, top, lineHeight);
      }
      return this.rectLike(previousRect.right, previousRect.top, previousRect.height || lineHeight);
    }
    return this.rectLike(blockLeft, blockRect.top, lineHeight);
  }

  textCaretRect(node, offset) {
    if (!node?.textContent?.length) return null;
    const probe = document.createRange();
    if (offset > 0) {
      probe.setStart(node, offset - 1);
      probe.setEnd(node, offset);
      const rect = probe.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return this.rectLike(rect.right, rect.top, rect.height);
    }
    if (offset < node.textContent.length) {
      probe.setStart(node, offset);
      probe.setEnd(node, offset + 1);
      const rect = probe.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return this.rectLike(rect.left, rect.top, rect.height);
    }
    try {
      const parent = node.parentNode;
      if (parent) {
        const span = document.createElement('span');
        span.textContent = '\u200b';
        const tempRange = document.createRange();
        tempRange.setStart(node, offset);
        tempRange.collapse(true);
        tempRange.insertNode(span);
        const rect = span.getBoundingClientRect();
        span.remove();
        if (rect && (rect.width || rect.height || rect.top)) {
          return this.rectLike(rect.left, rect.top, rect.height || 26);
        }
      }
    } catch (e) {}
    return null;
  }

  nodeStartRect(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return this.textCaretRect(node, 0);
    if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'BR') return null;
    const rect = node.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : null;
  }

  nodeEndRect(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return this.textCaretRect(node, node.textContent.length);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    if (node.tagName === 'BR') return node.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return rect && (rect.width || rect.height) ? rect : null;
  }

  previousContentRect(fromNode) {
    let node = fromNode.previousSibling;
    while (node) {
      const rect = this.nodeEndRect(node);
      if (rect && (rect.width || rect.height)) return rect;
      node = node.previousSibling;
    }
    return null;
  }

  rectLike(left, top, height) {
    return {
      left,
      right: left,
      top,
      bottom: top + height,
      width: 0,
      height,
      x: left,
      y: top,
      toJSON() { return this; },
    };
  }

  emptyBlockCaretRect(range) {
    if (!range.collapsed) return null;
    const editable = document.activeElement?.closest?.('.page-content');
    if (!editable) return null;
    const node = range.startContainer;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const block = element?.closest?.('[data-block-id]') || (element === editable ? this.editorBlocks(editable)[0] : null);
    if (!block || !editable.contains(block) || this.blockPlainText(block) || !this.isPlaceholderEmptyBlock(block)) return null;
    const rect = block.getBoundingClientRect();
    const styles = getComputedStyle(block);
    const lineHeight = Number.parseFloat(styles.lineHeight) || this.state.settings.fontSize * this.state.settings.lineHeight;
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
    const textIndent = Number.parseFloat(styles.textIndent) || 0;
    const align = styles.textAlign || 'left';
    let leftOffset = paddingLeft + textIndent;
    if (align === 'center') {
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      leftOffset = (rect.width - paddingLeft - paddingRight) / 2 + paddingLeft;
    } else if (align === 'right' || align === 'end') {
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      leftOffset = rect.width - paddingRight;
    }
    return {
      left: rect.left + leftOffset,
      right: rect.left + leftOffset,
      top: rect.top + paddingTop,
      bottom: rect.top + paddingTop + lineHeight,
      width: 0,
      height: lineHeight,
      x: rect.left + leftOffset,
      y: rect.top + paddingTop,
      toJSON() { return this; },
    };
  }

  isPlaceholderEmptyBlock(block) {
    const meaningful = [...block.childNodes].filter((node) => {
      if (node.nodeType === Node.TEXT_NODE) return cleanAnalysisResidue(node.textContent || '').length > 0;
      if (node.nodeType === Node.ELEMENT_NODE) return node.tagName !== 'BR';
      return false;
    });
    return meaningful.length === 0 && block.querySelectorAll('br').length <= 1;
  }

  updateCustomCaret() {
    const caret = document.getElementById('custom-caret');
    if (!caret || !document.getElementById('app-shell').classList.contains('custom-caret-enabled')) return;
    const sel = getSelection();
    const activeEditable = document.activeElement?.closest?.('.page-content');
    const paneId = this.state.workspace?.focusedPaneId || 'primary';
    const activePaneEl = activeEditable?.closest(`.workspace-pane[data-pane-id="${paneId}"]`);
    if (!sel.rangeCount || !activeEditable || !activePaneEl) {
      caret.style.display = 'none';
      return;
    }
    const range = sel.getRangeAt(0).cloneRange();
    if (!activeEditable.contains(range.commonAncestorContainer)) {
      caret.style.display = 'none';
      return;
    }
    const rect = this.rangeRect(range);
    if (!rect) return;

    // Check if the caret is within the scroll container's viewport bounds
    const scrollContainer = activeEditable.closest('.editor-scroll-area, #workspace-stage, .workspace-pane') || activeEditable;
    const scrollRect = scrollContainer.getBoundingClientRect();
    
    // Caret is out of bounds if coordinates are exactly 0,0 (hidden/detached state)
    // or if the caret is scrolled out of the scroll container's visible bounds.
    if ((rect.left === 0 && rect.top === 0) ||
        rect.top < scrollRect.top ||
        rect.bottom > scrollRect.bottom ||
        rect.left < scrollRect.left ||
        rect.right > scrollRect.right) {
      caret.style.display = 'none';
      return;
    }

    caret.style.display = 'block';
    caret.style.left = `${rect.left}px`;
    caret.style.top = `${rect.top}px`;
    caret.style.height = `${Math.max(4, rect.height || this.state.settings.fontSize * this.state.settings.lineHeight)}px`;
    this.updateCursorLight(activeEditable);


  }

  expandRangeToWord(range) {
    if (!range || !range.collapsed) return range;
    const node = range.startContainer;
    const offset = range.startOffset;
    if (node.nodeType !== Node.TEXT_NODE) {
      if (node.childNodes && node.childNodes[offset]) {
        const child = node.childNodes[offset];
        if (child.nodeType === Node.TEXT_NODE) {
          return this.expandTextNodeRangeToWord(child, 0);
        }
      }
      return range;
    }
    return this.expandTextNodeRangeToWord(node, offset);
  }

  expandTextNodeRangeToWord(node, offset) {
    const text = node.textContent;
    if (!text) return null;
    const isWordChar = (char) => {
      return /[\w\u0400-\u04FF\d'-]/iu.test(char);
    };
    let start = offset;
    while (start > 0 && isWordChar(text[start - 1])) {
      start--;
    }
    let end = offset;
    while (end < text.length && isWordChar(text[end])) {
      end++;
    }
    if (start < end) {
      const newRange = document.createRange();
      newRange.setStart(node, start);
      newRange.setEnd(node, end);
      return newRange;
    }
    return null;
  }

  insertTextAtCaret(text) {
    const activeEditable = document.activeElement?.closest?.('.page-content');
    const editor = this.nocturneEditor?.getByElement(activeEditable);
    if (editor) {
      editor.chain().focus().insertContent(String(text || '')).run();
      return;
    }
    try {
      document.execCommand('insertText', false, text);
    } catch (e) {
      console.error(e);
      const sel = getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      const editable = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
      editable?.closest?.('.page-content')?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  triggerKeyboardMacro(event, editable) {
    if (!this.state.settings.macros || !this.state.settings.macros.length) return false;
    const currentKey = this.getLayoutIndependentKey(event).toUpperCase();
    const held = new Set(this.currentlyPressedKeys || []);
    held.add(currentKey);
    
    const parts = [];
    if (event.ctrlKey) parts.push('CTRL');
    if (event.altKey) parts.push('ALT');
    if (event.shiftKey) parts.push('SHIFT');
    if (event.metaKey) parts.push('META');
    
    held.forEach((key) => {
      if (!['CONTROL', 'ALT', 'SHIFT', 'META'].includes(key)) {
        parts.push(key);
      }
    });
    
    const normalizeComboString = (str) => {
      return str.split('+')
        .map((s) => s.trim().toUpperCase())
        .map((s) => s === 'CONTROL' ? 'CTRL' : s === 'OPTION' || s === 'COMMAND' ? 'META' : s)
        .sort()
        .join('+');
    };
    
    const currentComboStr = parts.sort().join('+');
    const match = this.state.settings.macros.find((m) => {
      return normalizeComboString(m.keys) === currentComboStr;
    });
    
    if (match) {
      event.preventDefault();
      const hasModifiers = event.ctrlKey || event.altKey || event.metaKey;
      if (!hasModifiers && held.size > 1) {
        this.replaceTextBeforeCaret(1, match.value);
      } else {
        this.insertTextAtCaret(match.value);
      }
      return true;
    }
    return false;
  }

  spawnLetterAnimation(char) {
    const anim = this.state.settings.writingAnimation;
    if (!['sparkles', 'ripple', 'mist'].includes(anim) || !char.trim()) return;
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const rect = this.rangeRect(sel.getRangeAt(0).cloneRange());
    if (!rect) return;

    const letter = document.createElement('span');
    letter.className = `anim-letter type-${anim}`;
    letter.textContent = char;
    
    // Append to page shell instead of body so it scrolls with the text
    const pageShell = sel.anchorNode?.parentElement?.closest('.page-shell');
    if (pageShell) {
      pageShell.style.position = 'relative';
      const shellRect = pageShell.getBoundingClientRect();
      letter.style.position = 'absolute';
      letter.style.left = `${Math.max(0, rect.left - shellRect.left - this.state.settings.fontSize * 0.55)}px`;
      letter.style.top = `${Math.max(0, rect.top - shellRect.top)}px`;
      letter.style.fontFamily = this.state.settings.fontFamily;
      letter.style.fontSize = `${this.state.settings.fontSize}px`;
      pageShell.appendChild(letter);
      setTimeout(() => letter.remove(), 520);
    }
  }

  updateActiveBlock() {
    const editables = document.querySelectorAll('.page-content');
    editables.forEach(node => node.classList.remove('active-selection'));
    const sel = getSelection();
    const isSelectionActive = sel && !sel.isCollapsed && sel.toString().length > 0;
    const block = sel?.anchorNode?.parentElement?.closest?.('.page-content p,.page-content h2,.page-content blockquote');
    if (block) {
      const editable = block.closest('.page-content');
      if (isSelectionActive && editable) {
        editable.classList.add('active-selection');
      }
      const paneId = editable?.dataset.paneId;
      if (paneId && this.state.workspace?.focusedPaneId !== paneId) this.setFocusedPane(paneId);
    }
  }

  renderKb() {
    const active = this.state.activeKbTab;
    const detail = this.activeLoreDetailItem();
    
    let chars = [...this.state.lore.characters].sort((a, b) => a.order - b.order);
    let locs = [...this.state.lore.locations].sort((a, b) => a.order - b.order);
    let time = [...this.state.lore.timeline].sort((a, b) => (a.order - b.order) || parseTimelineRank(a.date) - parseTimelineRank(b.date));
    let notes = [...(this.state.lore.notes || [])].sort((a, b) => a.order - b.order);
    const activeSubtimeline = this.activeSubtimeline();

    document.getElementById('kb-modal').innerHTML = `
      <aside class="kb-sidebar">
        <h2 class="kb-title">База Знаний</h2>
        ${[
        ['characters', 'bx-user-pin', 'Персонажи'],
        ['locations', 'bx-map-alt', 'Локации'],
        ['timeline', 'bx-git-commit', 'Таймлайн'],
        ['notes', 'bx-note', 'Записи'],
      ].map(([id, icon, label]) => `<div class="settings-tab ${active === id ? 'active' : ''}" data-kb-tab="${id}"><i class="bx ${icon}"></i> ${label}</div>`).join('')}
        <div class="kb-dump-sidebar-section">
          <button class="pill-btn kb-sidebar-dump-btn" data-action="dump-full-kb" title="Скачать резервную копию всей базы знаний"><i class="bx bx-download"></i> Дамп всей БЗ</button>
        </div>
      </aside>
      <main class="kb-main">
        ${detail ? this.renderLoreDetail(detail.type, detail.item) : `
        <div class="kb-search-wrap">
          <i class="bx bx-search"></i>
          <input class="form-control kb-search-input" id="kb-search" placeholder="Поиск в базе знаний..." value="${escapeHtml(this.state.kbSearch || '')}">
        </div>
        <section class="kb-section ${active === 'characters' ? 'active' : ''}" id="kb-sec-characters">
          <div class="kb-header">
            <h1>Управление Персонажами</h1>
            <div class="kb-header-actions">
              <button class="pill-btn" data-action="dump-kb-characters" title="Экспорт персонажей"><i class="bx bx-download"></i> Дамп персонажей</button>
              <button class="pill-btn ai-btn" data-action="new-lore" data-lore-type="characters"><i class="bx bx-plus"></i> Создать профиль</button>
              <i class="bx bx-x kb-close-btn" data-action="close-kb"></i>
            </div>
          </div>
          <div class="character-grid" data-dnd-zone="characters">${chars.length ? chars.map((item) => this.characterCard(item, true)).join('') : this.emptyStateMarkup('bx-user-pin', 'Персонажей пока нет.', 'Создайте первый профиль, чтобы Nocturne начал узнавать имена в тексте.', 'new-lore', 'Создать профиль', 'data-lore-type="characters"')}</div>
        </section>
        <section class="kb-section ${active === 'locations' ? 'active' : ''}" id="kb-sec-locations">
          <div class="kb-header">
            <h1>Мир и Локации</h1>
            <div class="kb-header-actions">
              <button class="pill-btn" data-action="dump-kb-locations" title="Экспорт локаций"><i class="bx bx-download"></i> Дамп локаций</button>
              <button class="pill-btn ai-btn" data-action="new-lore" data-lore-type="locations"><i class="bx bx-plus"></i> Добавить место</button>
              <i class="bx bx-x kb-close-btn" data-action="close-kb"></i>
            </div>
          </div>
          <div class="locations-grid" data-dnd-zone="locations">${locs.length ? locs.map((item) => this.locationCard(item, true)).join('') : this.emptyStateMarkup('bx-map-alt', 'Локаций пока нет.', 'Добавьте первое место мира или сцены.', 'new-lore', 'Добавить место', 'data-lore-type="locations"')}</div>
        </section>
        <section class="kb-section ${active === 'timeline' ? 'active' : ''}" id="kb-sec-timeline">
          <div class="kb-header">
            <h1>Хронология Событий</h1>
            <div class="kb-header-actions">
              <button class="pill-btn" data-action="dump-kb-timeline" title="Экспорт таймлайнов"><i class="bx bx-download"></i> Дамп таймлайнов</button>
              <button class="pill-btn ai-btn" data-action="new-lore" data-lore-type="timeline"><i class="bx bx-plus"></i> Добавить событие</button>
              <i class="bx bx-x kb-close-btn" data-action="close-kb"></i>
            </div>
          </div>
          <div class="timeline-container" data-dnd-zone="timeline">${time.length ? time.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1, draggable: true })).join('') : this.emptyStateMarkup('bx-git-commit', 'Хронология пока пуста.', 'Добавьте первое событие, чтобы выстроить историю.', 'new-lore', 'Добавить событие', 'data-lore-type="timeline"')}</div>
        </section>
        <section class="kb-section ${active === 'notes' ? 'active' : ''}" id="kb-sec-notes">
          <div class="kb-header">
            <h1>Записи и Заметки</h1>
            <div class="kb-header-actions">
              <button class="pill-btn cleaner-btn" data-action="clean-all-notes" title="«Чистильщик™»"><i class="reaper-icon"></i>«Чистильщик™»</button>
              <button class="pill-btn" data-action="dump-kb-notes" title="Экспорт записей"><i class="bx bx-download"></i> Дамп записей</button>
              <button class="pill-btn ai-btn" data-action="new-lore" data-lore-type="notes"><i class="bx bx-plus"></i> Новая запись</button>
              <i class="bx bx-x kb-close-btn" data-action="close-kb"></i>
            </div>
          </div>
          <div class="character-grid" data-dnd-zone="notes">${notes.length ? notes.map((item) => this.noteCard(item, true)).join('') : this.emptyStateMarkup('bx-note', 'Записей пока нет.', 'Добавьте первую свободную запись или заметку к миру.', 'new-lore', 'Создать запись', 'data-lore-type="notes"')}</div>
        </section>
        ${activeSubtimeline ? this.subtimelinePanel(activeSubtimeline) : ''}
        `}
      </main>
      <div class="kb-dnd-overlay" id="kb-dnd-overlay">
        <div class="kb-dnd-overlay-box">
          <div class="kb-dnd-icon"><i class="bx bx-cloud-upload"></i></div>
          <h2>Импорт базы знаний Nocturne</h2>
          <p>Перетащите файлы с расширением .nocturnmemory, .nocturnecharacters, .nocturneplaces, .nocturnetimelines, .nocturnenotes или файлы отдельных сущностей сюда</p>
          <small>Дубликаты будут перезаписаны или добавлены как новые элементы</small>
        </div>
      </div>
    `;

    if (!detail) {
      this.setupKbDragDrop();
      this.applyKbSearch();
    }
    this.setupKbImportDnd();

    const searchInput = document.getElementById('kb-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.state.kbSearch = e.target.value;
        this.applyKbSearch();
      });
      // Do not auto-focus search to avoid stealing focus on tab switch
    }
  }

  activeLoreDetailItem() {
    const detail = this.state.activeLoreDetail;
    if (!detail) return null;
    const type = this.normalizeLoreType(detail.type);
    const item = this.state.lore[type]?.find((entry) => entry.id === detail.id);
    return item ? { type, item } : null;
  }

  normalizeLoreType(type) {
    if (type === 'character') return 'characters';
    if (type === 'location') return 'locations';
    if (type === 'note') return 'notes';
    return type;
  }

  singularLoreType(type) {
    return type === 'locations' ? 'location' : type === 'characters' ? 'character' : type === 'notes' ? 'note' : type;
  }

  openLoreDetail(type, id) {
    const normalizedType = this.normalizeLoreType(type);
    if (!['characters', 'locations', 'notes'].includes(normalizedType)) return;
    if (!this.state.lore[normalizedType]?.some((item) => item.id === id)) return;
    this.state.activeKbTab = normalizedType;
    this.state.mobile.kbTab = normalizedType;
    this.state.activeLoreDetail = { type: normalizedType, id };
    this.hideEntityHoverCards();
    if (this.isMobileLayout()) {
      this.switchMobileTab('lore', { keepOverlay: false });
      return;
    }
    const modal = document.getElementById('kb-modal');
    if (modal) {
      if (!modal.innerHTML.trim()) this.renderKb();
      modal.classList.add('active');
      this.renderKb();
    }
  }

  renderLoreDetail(type, item) {
    const kind = this.singularLoreType(type);
    const label = kind === 'location' ? 'Локация' : kind === 'note' ? 'Запись' : 'Персонаж';
    const title = this.entityDisplayName(item) || item.title || 'Без названия';
    const visual = kind === 'note' ? `<i class="bx bx-note"></i>` : (item.image ? `<img src="${item.image}" alt="">` : `<i class="bx ${item.icon || (kind === 'location' ? 'bx-buildings' : 'bx-user')}"></i>`);
    const docs = (item.documentIds || [])
      .map((id) => this.state.docs.find((doc) => doc.id === id))
      .filter(Boolean);
    const chips = (values) => values?.length
      ? `<div class="dossier-chip-row">${values.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div>`
      : '<p class="empty-state">Не заполнено.</p>';

    const associatedEvents = [];
    (this.state.lore.timeline || []).forEach(event => {
      const matchesMain = (kind === 'character' && Array.isArray(event.characterIds) && event.characterIds.includes(item.id)) ||
                          (kind === 'location' && Array.isArray(event.locationIds) && event.locationIds.includes(item.id)) ||
                          (kind === 'note' && Array.isArray(event.noteIds) && event.noteIds.includes(item.id));
      
      const matchedSubEvents = [];
      if (Array.isArray(event.subEvents)) {
        event.subEvents.forEach(sub => {
          const matchesSub = (kind === 'character' && Array.isArray(sub.characterIds) && sub.characterIds.includes(item.id)) ||
                             (kind === 'location' && Array.isArray(sub.locationIds) && sub.locationIds.includes(item.id)) ||
                             (kind === 'note' && Array.isArray(sub.noteIds) && sub.noteIds.includes(item.id));
          if (matchesSub) {
            matchedSubEvents.push(sub);
          }
        });
      }

      if (matchesMain || matchedSubEvents.length) {
        associatedEvents.push({ event, matchedSubEvents, matchesMain });
      }
    });

    associatedEvents.sort((a, b) => (a.event.order - b.event.order) || parseTimelineRank(a.event.date) - parseTimelineRank(b.event.date));

    let timelinePanelHTML = '';
    if (associatedEvents.length) {
      const listItems = associatedEvents.map(({ event, matchedSubEvents, matchesMain }) => {
        let itemsStr = '';
        if (matchesMain) {
          const role = (event.characterRoles && event.characterRoles[item.id]) || 'regular';
          let roleLabel = '';
          if (role === 'first_appearance') roleLabel = ' <span class="role-badge role-first-appearance"><i class="bx bx-star"></i> Появление</span>';
          else if (role === 'death') roleLabel = ' <span class="role-badge role-death"><i class="bx bx-skull"></i> Смерть</span>';
          
          itemsStr += `<li class="associated-timeline-item-row">
            <span class="assoc-date">${escapeHtml(event.date)}</span>
            <strong>${escapeHtml(event.title)}</strong>${roleLabel}
            <p>${escapeHtml(event.body)}</p>
          </li>`;
        }
        matchedSubEvents.forEach(sub => {
          const role = (sub.characterRoles && sub.characterRoles[item.id]) || 'regular';
          let roleLabel = '';
          if (role === 'first_appearance') roleLabel = ' <span class="role-badge role-first-appearance"><i class="bx bx-star"></i> Появление</span>';
          else if (role === 'death') roleLabel = ' <span class="role-badge role-death"><i class="bx bx-skull"></i> Смерть</span>';
          
          itemsStr += `<li class="associated-timeline-item-row sub-row">
            <span class="assoc-date">${escapeHtml(sub.date)}</span>
            <strong>${escapeHtml(sub.title)}</strong> <span class="subtimeline-type-badge"><i class="bx bx-git-branch"></i> Подсобытие</span>${roleLabel}
            <p>${escapeHtml(sub.body)}</p>
          </li>`;
        });
        return itemsStr;
      }).join('');

      timelinePanelHTML = `
        <div class="lore-detail-panel lore-detail-main timeline-associations-panel">
          <h3>Хронология и события (${associatedEvents.length})</h3>
          <ul class="associated-timeline-list">
            ${listItems}
          </ul>
        </div>
      `;
    } else {
      timelinePanelHTML = `
        <div class="lore-detail-panel lore-detail-main timeline-associations-panel">
          <h3>Хронология и события</h3>
          <p class="empty-state">Событий с участием этой записи пока не зафиксировано.</p>
        </div>
      `;
    }

    if (kind === 'note') {
      return `
        <article class="lore-detail note-detail">
          <div class="lore-detail-topbar">
            <button class="pill-btn" data-action="back-lore-list"><i class="bx bx-arrow-back"></i> Назад к списку</button>
            <button class="btn-icon" data-action="close-kb"><i class="bx bx-x"></i></button>
          </div>
          <header class="lore-detail-hero">
            <div class="lore-detail-visual">${visual}</div>
            <div>
              <div class="entity-chip">${label}</div>
              <h1>${escapeHtml(title)}</h1>
              <div class="lore-detail-actions">
                <button class="pill-btn ai-btn" data-action="edit-lore" data-lore-type="${type}" data-lore-id="${item.id}"><i class="bx bx-edit"></i> Редактировать</button>
                <button class="pill-btn" data-action="dump-single-entity" data-lore-type="${type}" data-lore-id="${item.id}"><i class="bx bx-download"></i> Дамп карточки</button>
                <button class="pill-btn" data-action="open-lore-side" data-entity-kind="${kind}" data-entity-id="${item.id}"><i class="bx bx-dock-right"></i> Открыть справа</button>
              </div>
            </div>
          </header>
          <section class="lore-detail-grid">
            <div class="lore-detail-panel lore-detail-main">
              <h3>Описание</h3>
              <p>${escapeHtml(item.body || 'Текст записи пуст.').replace(/\n/g, '<br>')}</p>
            </div>
            ${timelinePanelHTML}
          </section>
        </article>
      `;
    }

    return `
      <article class="lore-detail">
        <div class="lore-detail-topbar">
          <button class="pill-btn" data-action="back-lore-list"><i class="bx bx-arrow-back"></i> Назад к списку</button>
          <button class="btn-icon" data-action="close-kb"><i class="bx bx-x"></i></button>
        </div>
        <header class="lore-detail-hero">
          <div class="lore-detail-visual">${visual}</div>
          <div>
            <div class="entity-chip">${label}</div>
            <h1>${escapeHtml(title)}</h1>
            <p>${escapeHtml(item.role || (kind === 'location' ? 'Тип места не указан' : 'Роль не указана'))}</p>
            <div class="lore-detail-actions">
              <button class="pill-btn ai-btn" data-action="edit-lore" data-lore-type="${type}" data-lore-id="${item.id}"><i class="bx bx-edit"></i> Редактировать</button>
              <button class="pill-btn" data-action="dump-single-entity" data-lore-type="${type}" data-lore-id="${item.id}"><i class="bx bx-download"></i> Дамп карточки</button>
              <button class="pill-btn" data-action="open-lore-side" data-entity-kind="${kind}" data-entity-id="${item.id}"><i class="bx bx-dock-right"></i> Открыть справа</button>
              <button class="pill-btn" data-action="open-entity-mentions" data-entity-kind="${kind}" data-entity-id="${item.id}"><i class="bx bx-search-alt"></i> Все упоминания</button>
              <button class="pill-btn" data-action="new-lore-floating-note" data-entity-kind="${kind}" data-entity-id="${item.id}"><i class="bx bx-note"></i> Заметка</button>
            </div>
          </div>
        </header>
        <section class="lore-detail-grid">
          <div class="lore-detail-panel lore-detail-main">
            <h3>Описание</h3>
            <p>${escapeHtml(item.body || 'Описание пока не заполнено.')}</p>
          </div>
          <div class="lore-detail-panel">
            <h3>Алиасы</h3>
            ${chips(item.aliases || [])}
          </div>
          <div class="lore-detail-panel">
            <h3>Варианты упоминаний</h3>
            ${chips(item.mentionForms || [])}
          </div>
          ${timelinePanelHTML}
          <div class="lore-detail-panel lore-detail-main">
            <h3>Связанные документы</h3>
            ${docs.length ? `<div class="dossier-doc-list">${docs.map((doc) => `<button type="button" data-doc-id="${doc.id}"><i class="bx bx-file"></i><span>${escapeHtml(doc.title)}</span></button>`).join('')}</div>` : '<p class="empty-state">Связанных документов пока нет.</p>'}
          </div>
        </section>
      </article>
    `;
  }

  applyKbSearch() {
    const q = (this.state.kbSearch || '').toLowerCase().trim();
    const isSearching = q.length > 0;
    document.querySelectorAll('.char-card, .loc-card, .timeline-item').forEach(el => {
      const item = this.loreItemForElement(el);
      if (item) {
        const names = item.title ? [item.title] : this.entityMentionValues(item);
        const docTitles = (item.chapterIds || []).map(id => this.state.docs.find(d => d.id === id)?.title || '').filter(Boolean);
        const text = `${names.join(' ')} ${item.date || ''} ${item.body || item.role || ''} ${docTitles.join(' ')}`;
        el.classList.toggle('hidden', isSearching && !text.toLowerCase().includes(q));
        el.toggleAttribute('draggable', !isSearching && !window.Sortable);
      }
    });
    document.querySelectorAll('[data-dnd-zone]').forEach((zone) => {
      zone.__sortable?.option?.('disabled', isSearching);
    });
    document.querySelectorAll('[data-dnd-zone="timeline"], [data-dnd-zone="subtimeline"]').forEach((zone) => this.updateTimelineConnectors(zone));
  }

  loreItemForElement(el) {
    const id = el?.dataset?.loreId;
    const type = el?.dataset?.loreType;
    if (!id || !type) return null;
    if (type === 'subtimeline') {
      const parent = this.timelineEvent(el.dataset.parentId);
      return parent?.subEvents?.find((event) => event.id === id) || null;
    }
    return this.state.lore[type]?.find((item) => item.id === id) || null;
  }

  setupKbDragDrop() {
    this.kbSortables.forEach((sortable) => sortable.destroy?.());
    this.kbSortables = [];
    document.querySelectorAll('[data-dnd-zone]').forEach(zone => {
      this.setupKbSortable(zone);
    });
  }

  showCharExportModal(char, cleanName) {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal search-choice-modal" style="width: min(920px, calc(100vw - 44px));">
        <div class="modal-head-row">
          <div><h2>Выберите формат экспорта</h2><p>Персонаж: <strong>${escapeHtml(char.displayName || char.name || 'Без имени')}</strong></p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="search-mode-grid" style="grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
          <button class="search-mode-card" data-fmt="nocturnechar" style="min-height: 150px; padding: 14px; gap: 6px;">
            <i class="bx bx-file-blank"></i>
            <strong>Резервная копия (.nocturnechar)</strong>
            <span>Для переноса персонажа между проектами Ноктюрна.</span>
            <small>Рекомендуемый формат импорта/экспорта Ноктюрна.</small>
          </button>
          <button class="search-mode-card" data-fmt="txt" style="min-height: 150px; padding: 14px; gap: 6px;">
            <i class="bx bx-text"></i>
            <strong>Текстовое досье (.txt)</strong>
            <span>Плоский текст — досье для чтения, печати и AI.</span>
            <small>Текстовый формат plain text.</small>
          </button>
          <button class="search-mode-card" data-fmt="docx" style="min-height: 150px; padding: 14px; gap: 6px;">
            <i class="bx bxs-file-doc"></i>
            <strong>Документ Word (.docx)</strong>
            <span>Microsoft Word — для детального чтения и редактирования.</span>
            <small>Текстовый формат Microsoft Word.</small>
          </button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelectorAll('.search-mode-card').forEach(btn => {
      btn.addEventListener('click', () => {
        const fmt = btn.dataset.fmt;
        overlay.classList.remove('active');
        if (fmt === 'nocturnechar') {
          this.exportKbData({ type: 'nocturnechar', character: char }, `${cleanName}.nocturnechar`);
        } else if (fmt === 'txt') {
          this.exportCharAsTxt(char, cleanName);
        } else if (fmt === 'docx') {
          this.exportCharAsDocx(char, cleanName);
        }
      });
    });
  }

  exportCharAsTxt(char, cleanName) {
    const lines = [];
    const esc = (v) => String(v || '').trim();
    const fullName = [char.firstName, char.lastName].filter(Boolean).join(' ') || char.displayName || char.name || '';
    lines.push(`=== ПЕРСОНАЖ: ${fullName} ===`);
    lines.push('');
    if (char.displayName) lines.push(`Имя / Псевдоним: ${esc(char.displayName)}`);
    if (char.age) lines.push(`Возраст: ${esc(char.age)}`);
    if (char.gender) lines.push(`Пол: ${esc(char.gender)}`);
    if (char.faction) lines.push(`Фракция: ${esc(char.faction)}`);
    if (char.role) lines.push(`Роль: ${esc(char.role)}`);
    if (char.aliases && char.aliases.length) lines.push(`Псевдонимы / Имена: ${char.aliases.join(', ')}`);
    if (char.traits && char.traits.length) lines.push(`Черты характера: ${char.traits.join(', ')}`);
    if (char.body) {
      lines.push('');
      lines.push('--- СВЕДЕНИЯ ---');
      lines.push(esc(char.body));
    }
    const events = (this.state.lore.timeline || []).filter(e => Array.isArray(e.characterIds) && e.characterIds.includes(char.id));
    if (events.length) {
      lines.push('');
      lines.push('--- СОБЫТИЯ ТАЙМЛАЙНА ---');
      events.forEach(e => {
        const role = e.characterRoles?.[char.id] || 'regular';
        const roleLabel = role === 'first_appearance' ? ' [ПОЯВЛЕНИЕ]' : role === 'death' ? ' [СМЕРТЬ]' : '';
        lines.push(`  ${esc(e.date)} — ${esc(e.title)}${roleLabel}`);
      });
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    this.downloadBlob(blob, `${cleanName}.txt`);
  }

  generateDocxBlob(title, paragraphsHtml) {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>`,
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphsHtml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    };
    return this.createZip(files);
  }

  exportCharAsDocx(char, cleanName) {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fullName = [char.firstName, char.lastName].filter(Boolean).join(' ') || char.displayName || char.name || '';
    const rows = [];
    const addRow = (label, value) => {
      if (!value) return;
      rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
    };
    addRow('Имя', fullName);
    addRow('Псевдоним', char.displayName);
    addRow('Возраст', char.age);
    addRow('Пол', char.gender);
    addRow('Фракция', char.faction);
    addRow('Роль', char.role);
    if (char.aliases?.length) addRow('Имена', char.aliases.join(', '));
    if (char.traits?.length) addRow('Черты', char.traits.join(', '));
    const events = (this.state.lore.timeline || []).filter(e => Array.isArray(e.characterIds) && e.characterIds.includes(char.id));
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc('Персонаж: ' + fullName)}</w:t></w:r></w:p>`;
    if (rows.length) {
      paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
    }
    if (char.body) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Сведения</w:t></w:r></w:p>` + char.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
    }
    if (events.length) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>События таймлайна</w:t></w:r></w:p>` + events.map(e => `<w:p><w:r><w:t xml:space="preserve">${esc(e.date + ' — ' + e.title)}</w:t></w:r></w:p>`).join('');
    }
    const blob = this.generateDocxBlob(fullName, paragraphs);
    this.downloadBlob(blob, `${cleanName}.docx`);
  }

  exportLocationAsDocx(loc, cleanName) {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const name = loc.displayName || loc.name || '';
    const rows = [];
    const addRow = (label, value) => {
      if (!value) return;
      rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
    };
    addRow('Название', name);
    addRow('Альтернативные названия', loc.aliases?.join(', '));
    addRow('Тип / Описание', loc.role);
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc('Локация: ' + name)}</w:t></w:r></w:p>`;
    if (rows.length) {
      paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
    }
    if (loc.body) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Описание</w:t></w:r></w:p>` + loc.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
    }
    const blob = this.generateDocxBlob(name, paragraphs);
    this.downloadBlob(blob, `${cleanName}.docx`);
  }

  exportAllNotesAsDocx() {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Сводка записей</w:t></w:r></w:p>`;
    (this.state.lore.notes || []).forEach((note) => {
      const title = note.title || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(title)}</w:t></w:r></w:p>`;
      if (note.body) {
        paragraphs += note.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
    });
    const blob = this.generateDocxBlob('Сводка записей', paragraphs);
    this.downloadBlob(blob, 'notes_dump.docx');
  }

  exportNoteAsDocx(note, cleanName) {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = note.title || '';
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc('Запись: ' + title)}</w:t></w:r></w:p>`;
    if (note.body) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Текст</w:t></w:r></w:p>` + note.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
    }
    const blob = this.generateDocxBlob(title || 'Запись', paragraphs);
    this.downloadBlob(blob, `${cleanName}.docx`);
  }

  exportEventAsDocx(eventItem, cleanName) {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const title = eventItem.title || '';
    const rows = [];
    const addRow = (label, value) => {
      if (!value) return;
      rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
    };
    addRow('Название события', title);
    addRow('Дата / Время', eventItem.date);
    const charNames = (eventItem.characterIds || []).map(id => this.state.lore.characters.find(c => c.id === id)?.name).filter(Boolean).join(', ');
    const locNames = (eventItem.locationIds || []).map(id => this.state.lore.locations.find(l => l.id === id)?.name).filter(Boolean).join(', ');
    addRow('Персонажи', charNames);
    addRow('Локации', locNames);
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc('Событие: ' + title)}</w:t></w:r></w:p>`;
    if (rows.length) {
      paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
    }
    if (eventItem.body) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Описание</w:t></w:r></w:p>` + eventItem.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
    }
    if (eventItem.subEvents?.length) {
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Вложенные события (Сабтаймлайн)</w:t></w:r></w:p>`;
      eventItem.subEvents.forEach(sub => {
        paragraphs += `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(sub.date || '')} — ${esc(sub.title || '')}</w:t></w:r></w:p>`;
        if (sub.body) {
          paragraphs += sub.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">  ${esc(line)}</w:t></w:r></w:p>`).join('');
        }
      });
    }
    const blob = this.generateDocxBlob(title, paragraphs);
    this.downloadBlob(blob, `${cleanName}.docx`);
  }

  exportAllCharactersAsDocx() {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Все персонажи Базы Знаний</w:t></w:r></w:p>`;
    this.state.lore.characters.forEach((char) => {
      const fullName = [char.firstName, char.lastName].filter(Boolean).join(' ') || char.displayName || char.name || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(fullName)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      addRow('Псевдоним', char.displayName);
      addRow('Возраст', char.age);
      addRow('Пол', char.gender);
      addRow('Фракция', char.faction);
      addRow('Роль', char.role);
      if (char.aliases?.length) addRow('Имена', char.aliases.join(', '));
      if (char.traits?.length) addRow('Черты', char.traits.join(', '));
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (char.body) {
        paragraphs += char.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
    });
    const blob = this.generateDocxBlob('Персонажи', paragraphs);
    this.downloadBlob(blob, 'characters.docx');
  }

  exportAllLocationsAsDocx() {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Все локации Базы Знаний</w:t></w:r></w:p>`;
    this.state.lore.locations.forEach((loc) => {
      const name = loc.displayName || loc.name || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(name)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      addRow('Альтернативные названия', loc.aliases?.join(', '));
      addRow('Тип / Описание', loc.role);
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (loc.body) {
        paragraphs += loc.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
    });
    const blob = this.generateDocxBlob('Локации', paragraphs);
    this.downloadBlob(blob, 'locations.docx');
  }

  exportAllTimelineAsDocx() {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Хронология Событий</w:t></w:r></w:p>`;
    this.state.lore.timeline.forEach((eventItem) => {
      const title = eventItem.title || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(eventItem.date || '')} — ${esc(title)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      const charNames = (eventItem.characterIds || []).map(id => this.state.lore.characters.find(c => c.id === id)?.name).filter(Boolean).join(', ');
      const locNames = (eventItem.locationIds || []).map(id => this.state.lore.locations.find(l => l.id === id)?.name).filter(Boolean).join(', ');
      addRow('Персонажи', charNames);
      addRow('Локации', locNames);
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (eventItem.body) {
        paragraphs += eventItem.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
      if (eventItem.subEvents?.length) {
        paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Вложенные события (Сабтаймлайн)</w:t></w:r></w:p>`;
        eventItem.subEvents.forEach(sub => {
          paragraphs += `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">  ${esc(sub.date || '')} — ${esc(sub.title || '')}</w:t></w:r></w:p>`;
          if (sub.body) {
            paragraphs += sub.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">    ${esc(line)}</w:t></w:r></w:p>`).join('');
          }
        });
      }
    });
    const blob = this.generateDocxBlob('Таймлайн', paragraphs);
    this.downloadBlob(blob, 'timeline.docx');
  }

  exportAllKbAsDocx() {
    const esc = (v) => String(v || '').trim()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let paragraphs = `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>База Знаний Проекта</w:t></w:r></w:p>`;
    
    paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Раздел 1: Персонажи</w:t></w:r></w:p>`;
    this.state.lore.characters.forEach((char) => {
      const fullName = [char.firstName, char.lastName].filter(Boolean).join(' ') || char.displayName || char.name || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(fullName)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      addRow('Псевдоним', char.displayName);
      addRow('Возраст', char.age);
      addRow('Пол', char.gender);
      addRow('Фракция', char.faction);
      addRow('Роль', char.role);
      if (char.aliases?.length) addRow('Имена', char.aliases.join(', '));
      if (char.traits?.length) addRow('Черты', char.traits.join(', '));
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (char.body) {
        paragraphs += char.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
    });

    paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Раздел 2: Локации</w:t></w:r></w:p>`;
    this.state.lore.locations.forEach((loc) => {
      const name = loc.displayName || loc.name || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(name)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      addRow('Альтернативные названия', loc.aliases?.join(', '));
      addRow('Тип / Описание', loc.role);
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (loc.body) {
        paragraphs += loc.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
    });

    paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Раздел 3: Хронология Событий</w:t></w:r></w:p>`;
    this.state.lore.timeline.forEach((eventItem) => {
      const title = eventItem.title || '';
      paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${esc(eventItem.date || '')} — ${esc(title)}</w:t></w:r></w:p>`;
      const rows = [];
      const addRow = (label, value) => {
        if (!value) return;
        rows.push(`<w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(label)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc></w:tr>`);
      };
      const charNames = (eventItem.characterIds || []).map(id => this.state.lore.characters.find(c => c.id === id)?.name).filter(Boolean).join(', ');
      const locNames = (eventItem.locationIds || []).map(id => this.state.lore.locations.find(l => l.id === id)?.name).filter(Boolean).join(', ');
      addRow('Персонажи', charNames);
      addRow('Локации', locNames);
      if (rows.length) {
        paragraphs += `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="EAEAEA"/></w:tblBorders></w:tblPr>${rows.join('')}</w:tbl>`;
      }
      if (eventItem.body) {
        paragraphs += eventItem.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      }
      if (eventItem.subEvents?.length) {
        paragraphs += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Вложенные события (Сабтаймлайн)</w:t></w:r></w:p>`;
        eventItem.subEvents.forEach(sub => {
          paragraphs += `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">  ${esc(sub.date || '')} — ${esc(sub.title || '')}</w:t></w:r></w:p>`;
          if (sub.body) {
            paragraphs += sub.body.split('\n').map(line => `<w:p><w:r><w:t xml:space="preserve">    ${esc(line)}</w:t></w:r></w:p>`).join('');
          }
        });
      }
    });
    const blob = this.generateDocxBlob('База Знаний', paragraphs);
    this.downloadBlob(blob, 'world_kb.docx');
  }

  openDumpChooser(dumpType, options = {}) {
    const overlay = document.getElementById('form-overlay');
    let title = '';
    let subtitle = '';
    let appLabel = '';
    let appDesc = '';
    let appExt = '';
    let docxLabel = '';
    let docxDesc = '';
    if (dumpType === 'full-kb') {
      title = 'Дамп всей Базы Знаний';
      subtitle = 'Экспортируйте всех персонажей, локации и хронологию.';
      appLabel = 'Резервная копия БЗ (.nocturnmemory)';
      appDesc = 'Для переноса базы знаний в другие проекты Ноктюрна.';
      appExt = 'world_kb.nocturnmemory';
      docxLabel = 'Документ Word (.docx)';
      docxDesc = 'Красиво оформленный текстовый файл со всеми статьями БЗ.';
    } else if (dumpType === 'kb-characters') {
      title = 'Дамп персонажей';
      subtitle = 'Экспортируйте весь список персонажей вашей истории.';
      appLabel = 'Резервная копия персонажей (.nocturnecharacters)';
      appDesc = 'Файл обмена для переноса персонажей.';
      appExt = 'characters.nocturnecharacters';
      docxLabel = 'Документ Word (.docx)';
      docxDesc = 'Сводный текстовый файл со всеми досье персонажей.';
    } else if (dumpType === 'kb-locations') {
      title = 'Дамп локаций';
      subtitle = 'Экспортируйте все места и локации мира.';
      appLabel = 'Резервная копия локаций (.nocturneplaces)';
      appDesc = 'Файл обмена для переноса локаций.';
      appExt = 'places.nocturneplaces';
      docxLabel = 'Документ Word (.docx)';
      docxDesc = 'Сводный текстовый файл со всеми описаниями локаций.';
    } else if (dumpType === 'kb-timeline') {
      title = 'Дамп таймлайнов';
      subtitle = 'Экспортируйте хронологию событий.';
      appLabel = 'Резервная копия таймлайнов (.nocturnetimelines)';
      appDesc = 'Файл обмена для переноса событий хронологии.';
      appExt = 'timeline.nocturnetimelines';
      docxLabel = 'Документ Word (.docx)';
      docxDesc = 'Сводный текстовый файл со всей хронологией событий.';
    } else if (dumpType === 'kb-notes') {
      title = 'Дамп записей';
      subtitle = 'Экспортируйте ваши записи базы знаний.';
      appLabel = 'Резервная копия записей (.nocturnenotes)';
      appDesc = 'Файл обмена для переноса записей.';
      appExt = 'notes.nocturnenotes';
      docxLabel = 'Документ Word (.docx)';
      docxDesc = 'Сводный текстовый файл со всеми записями.';
    } else if (dumpType === 'single-entity') {
      const type = options.type;
      const item = options.item;
      const cleanName = options.cleanName;
      const name = item.displayName || item.name || item.title || 'Карточка';
      title = `Дамп карточки: ${name}`;
      subtitle = `Экспортируйте информацию о сущности.`;
      if (type === 'characters') {
        this.showCharExportModal(item, cleanName);
        return;
      } else if (type === 'locations') {
        appLabel = 'Файл локации (.nocturneplace)';
        appDesc = 'Для переноса этой локации между проектами Ноктюрна.';
        appExt = `${cleanName}.nocturneplace`;
        docxLabel = 'Документ Word (.docx)';
        docxDesc = 'Карточка локации для печати и вычитки.';
      } else if (type === 'notes') {
        appLabel = 'Файл записи (.nocturnenote)';
        appDesc = 'Для переноса этой записи между проектами Ноктюрна.';
        appExt = `${cleanName}.nocturnenote`;
        docxLabel = 'Документ Word (.docx)';
        docxDesc = 'Запись для печати и вычитки.';
      } else {
        appLabel = 'Файл события (.nocturnetime)';
        appDesc = 'Для переноса этого события между проектами Ноктюрна.';
        appExt = `${cleanName}.nocturnetime`;
        docxLabel = 'Документ Word (.docx)';
        docxDesc = 'Карточка события и его сабтаймлайн.';
      }
    }
    overlay.innerHTML = `
      <div class="form-modal search-choice-modal dump-choice-modal">
        <div class="modal-head-row">
          <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="search-mode-grid">
          <button class="search-mode-card" data-format-type="app">
            <i class="bx bx-file-blank"></i>
            <strong>${escapeHtml(appLabel)}</strong>
            <span>${escapeHtml(appDesc)}</span>
            <small>Рекомендуемый формат импорта/экспорта Ноктюрна.</small>
          </button>
          <button class="search-mode-card" data-format-type="docx">
            <i class="bx bxs-file-doc"></i>
            <strong>${escapeHtml(docxLabel)}</strong>
            <span>${escapeHtml(docxDesc)}</span>
            <small>Текстовый формат Microsoft Word.</small>
          </button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelectorAll('.search-mode-card').forEach((btn) => {
      btn.onclick = () => {
        overlay.classList.remove('active');
        const format = btn.dataset.formatType;
        if (format === 'app') {
          if (dumpType === 'full-kb') {
            this.exportKbData({ type: 'nocturnmemory', lore: this.state.lore }, 'world_kb.nocturnmemory');
          } else if (dumpType === 'kb-characters') {
            this.exportKbData({ type: 'nocturnecharacters', characters: this.state.lore.characters }, 'characters.nocturnecharacters');
          } else if (dumpType === 'kb-locations') {
            this.exportKbData({ type: 'nocturneplaces', locations: this.state.lore.locations }, 'places.nocturneplaces');
          } else if (dumpType === 'kb-timeline') {
            this.exportKbData({ type: 'nocturnetimelines', timeline: this.state.lore.timeline }, 'timeline.nocturnetimelines');
          } else if (dumpType === 'kb-notes') {
            this.exportKbData({ type: 'nocturnenotes', notes: this.state.lore.notes }, 'notes.nocturnenotes');
          } else if (dumpType === 'single-entity') {
            const type = options.type;
            const item = options.item;
            if (type === 'locations') {
              this.exportKbData({ type: 'nocturneplace', location: item }, appExt);
            } else if (type === 'notes') {
              this.exportKbData({ type: 'nocturnenote', note: item }, appExt);
            } else {
              this.exportKbData({ type: 'nocturnetime', event: item }, appExt);
            }
          }
        } else if (format === 'docx') {
          if (dumpType === 'full-kb') {
            this.exportAllKbAsDocx();
          } else if (dumpType === 'kb-characters') {
            this.exportAllCharactersAsDocx();
          } else if (dumpType === 'kb-locations') {
            this.exportAllLocationsAsDocx();
          } else if (dumpType === 'kb-timeline') {
            this.exportAllTimelineAsDocx();
          } else if (dumpType === 'kb-notes') {
            this.exportAllNotesAsDocx();
          } else if (dumpType === 'single-entity') {
            const type = options.type;
            const item = options.item;
            const cleanName = options.cleanName;
            if (type === 'locations') {
              this.exportLocationAsDocx(item, cleanName);
            } else if (type === 'notes') {
              this.exportNoteAsDocx(item, cleanName);
            } else {
              this.exportEventAsDocx(item, cleanName);
            }
          }
        }
      };
    });
  }

  exportKbData(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    this.downloadBlob(blob, filename);
  }

  setupKbImportDnd() {
    const kbModal = document.getElementById('kb-modal');
    if (!kbModal) return;
    
    const overlay = document.getElementById('kb-dnd-overlay');
    if (!overlay) return;
    
    kbModal.ondragenter = (e) => {
      if (e.dataTransfer && e.dataTransfer.types && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      overlay.classList.add('active');
    };
    
    kbModal.ondragover = (e) => {
      if (e.dataTransfer && e.dataTransfer.types && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
    };
    
    kbModal.ondragleave = (e) => {
      e.preventDefault();
      if (!kbModal.contains(e.relatedTarget)) {
        overlay.classList.remove('active');
      }
    };
    
    kbModal.ondrop = async (e) => {
      if (e.dataTransfer && e.dataTransfer.types && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      overlay.classList.remove('active');
      
      const files = e.dataTransfer?.files;
      if (files && files.length) {
        await this.importKbFiles(files);
      }
    };
  }

  async importKbFiles(files) {
    let successCount = 0;
    let failCount = 0;
    
    let totalImported = {
      characters: 0,
      locations: 0,
      timeline: 0,
      notes: 0
    };
    
    const validExtensions = [
      '.nocturnmemory',
      '.nocturnecharacters',
      '.nocturneplaces',
      '.nocturnetimelines',
      '.nocturnechar',
      '.nocturneplace',
      '.nocturnetime',
      '.nocturnenote',
      '.nocturnenotes'
    ];
    
    for (const file of files) {
      const name = file.name;
      const extension = name.substring(name.lastIndexOf('.')).toLowerCase();
      
      if (!validExtensions.includes(extension)) {
        failCount++;
        continue;
      }
      
      try {
        const text = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target.result);
          reader.onerror = (err) => reject(err);
          reader.readAsText(file);
        });
        
        const data = JSON.parse(text);
        const imported = await this.processImportedKbData(data);
        if (imported) {
          successCount++;
          totalImported.characters += imported.characters;
          totalImported.locations += imported.locations;
          totalImported.timeline += imported.timeline;
          totalImported.notes += imported.notes;
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
      }
    }
    
    if (successCount > 0) {
      await this.saveLore();
      this.refreshVisibleEntityLinks();
      
      let categories = [];
      if (totalImported.characters > 0) categories.push({ name: 'characters', label: 'Персонажи', count: totalImported.characters });
      if (totalImported.locations > 0) categories.push({ name: 'locations', label: 'Локации', count: totalImported.locations });
      if (totalImported.timeline > 0) categories.push({ name: 'timeline', label: 'Таймлайн', count: totalImported.timeline });
      if (totalImported.notes > 0) categories.push({ name: 'notes', label: 'Записи', count: totalImported.notes });
      
      await this.animateKbImport(categories, failCount);
    } else if (failCount > 0) {
      this.toast(`Не удалось импортировать файлы (${failCount} ошибок). Проверьте формат файлов.`);
    }
  }

  async animateKbImport(categories, failCount) {
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx bx-cloud-download"></i>
        </div>
        <h3>Импортируем данные...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    
    overlay.classList.add('active');
    // More generous initial delay (600ms) for high-end organic feel
    await new Promise(r => setTimeout(r, 600));
    
    const listEl = overlay.querySelector('.kb-import-progress-list');
    
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${i * 150}ms`;
      step.innerHTML = `<span>Импорт: ${cat.label} (${cat.count})</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      // Wait 350ms per step to let the user appreciate the checkmarks
      await new Promise(r => setTimeout(r, 350));
    }
    
    if (failCount > 0) {
      const step = document.createElement('div');
      step.className = 'kb-import-step fail';
      step.style.animationDelay = `${categories.length * 150}ms`;
      step.innerHTML = `<span>Пропущено/ошибок: ${failCount}</span><i class="bx bx-x-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    if (categories.length === 1) {
      const singleCat = categories[0];
      this.state.activeKbTab = singleCat.name;
      if (this.isMobileLayout()) {
        this.state.mobile.kbTab = singleCat.name;
      }
      this.state.activeLoreDetail = null;
      if (singleCat.name !== 'timeline') this.state.activeSubtimelineId = null;
    }
    
    this.renderKb();
    
    // Hold success state for 1 full second
    await new Promise(r => setTimeout(r, 1000));
    overlay.classList.remove('active');
    
    if (categories.length === 1) {
      const singleCat = categories[0];
      this.toast(`Импортировано в раздел "${singleCat.label}": ${singleCat.count} записей.`);
    } else {
      const desc = categories.map(c => `${c.label}: ${c.count}`).join(', ');
      this.toast(`Импорт завершен. Загружено: ${desc}`);
    }
  }

  async animateDocImport(importedDocs, reviewFilesCount, failCount) {
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx bx-file-import"></i>
        </div>
        <h3>Импортируем документы...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    
    overlay.classList.add('active');
    await new Promise(r => setTimeout(r, 600));
    
    const listEl = overlay.querySelector('.kb-import-progress-list');
    
    for (let i = 0; i < importedDocs.length; i++) {
      const item = importedDocs[i];
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${i * 150}ms`;
      step.innerHTML = `<span>Импорт: ${item.file.name}</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    if (reviewFilesCount > 0) {
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${importedDocs.length * 150}ms`;
      step.innerHTML = `<span>Редакторские правки (${reviewFilesCount})</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    if (failCount > 0) {
      const step = document.createElement('div');
      step.className = 'kb-import-step fail';
      step.style.animationDelay = `${(importedDocs.length + 1) * 150}ms`;
      step.innerHTML = `<span>Ошибок при импорте: ${failCount}</span><i class="bx bx-x-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    this.renderAll();
    
    await new Promise(r => setTimeout(r, 1000));
    overlay.classList.remove('active');
    
    this.toast(reviewFilesCount && importedDocs.length ? 'Документ и редакторские правки импортированы.' : `Импортировано документов: ${importedDocs.length}`);
  }

  async processImportedKbData(data) {
    if (!data || typeof data !== 'object') return null;
    const type = data.type;
    let result = { characters: 0, locations: 0, timeline: 0, notes: 0 };
    
    if (type === 'nocturnmemory') {
      if (data.lore) {
        if (Array.isArray(data.lore.characters)) {
          data.lore.characters.forEach(c => this.upsertCharacter(c));
          result.characters += data.lore.characters.length;
        }
        if (Array.isArray(data.lore.locations)) {
          data.lore.locations.forEach(l => this.upsertLocation(l));
          result.locations += data.lore.locations.length;
        }
        if (Array.isArray(data.lore.timeline)) {
          data.lore.timeline.forEach(t => this.upsertTimelineEvent(t));
          result.timeline += data.lore.timeline.length;
        }
        return result;
      }
    }
    if (type === 'nocturnecharacters') {
      if (Array.isArray(data.characters)) {
        data.characters.forEach(c => this.upsertCharacter(c));
        result.characters += data.characters.length;
        return result;
      }
    }
    if (type === 'nocturneplaces') {
      if (Array.isArray(data.locations)) {
        data.locations.forEach(l => this.upsertLocation(l));
        result.locations += data.locations.length;
        return result;
      }
    }
    if (type === 'nocturnetimelines') {
      if (Array.isArray(data.timeline)) {
        data.timeline.forEach(t => this.upsertTimelineEvent(t));
        result.timeline += data.timeline.length;
        return result;
      }
    }
    if (type === 'nocturnechar') {
      if (data.character) {
        this.upsertCharacter(data.character);
        result.characters += 1;
        return result;
      }
    }
    if (type === 'nocturneplace') {
      if (data.location) {
        this.upsertLocation(data.location);
        result.locations += 1;
        return result;
      }
    }
    if (type === 'nocturnetime') {
      if (data.event) {
        this.upsertTimelineEvent(data.event);
        result.timeline += 1;
        return result;
      }
    }
    if (type === 'nocturnenotes') {
      if (Array.isArray(data.notes)) {
        data.notes.forEach(n => this.upsertNote(n));
        result.notes += data.notes.length;
        return result;
      }
    }
    if (type === 'nocturnenote') {
      if (data.note) {
        this.upsertNote(data.note);
        result.notes += 1;
        return result;
      }
    }
    return null;
  }

  upsertNote(note) {
    const norm = this.normalizeNote(note, (this.state.lore.notes || []).length);
    const idx = (this.state.lore.notes || []).findIndex(n => n.id === norm.id);
    if (idx >= 0) {
      this.state.lore.notes[idx] = norm;
    } else {
      if (!this.state.lore.notes) this.state.lore.notes = [];
      this.state.lore.notes.push(norm);
    }
  }

  upsertCharacter(char) {
    const norm = this.normalizeCharacter(char, this.state.lore.characters.length);
    // Try ID first, then case-insensitive name to avoid duplicates on import
    let idx = this.state.lore.characters.findIndex(c => c.id === norm.id);
    if (idx < 0) {
      const normName = (norm.name || norm.displayName || '').trim().toLowerCase();
      if (normName) idx = this.state.lore.characters.findIndex(c => (c.name || c.displayName || '').trim().toLowerCase() === normName);
    }
    if (idx >= 0) {
      norm.id = this.state.lore.characters[idx].id; // preserve original ID for timeline links
      this.state.lore.characters[idx] = norm;
    } else {
      this.state.lore.characters.push(norm);
    }
  }

  upsertLocation(loc) {
    const norm = this.normalizeLocation(loc, this.state.lore.locations.length);
    // Try ID first, then case-insensitive name to avoid duplicates on import
    let idx = this.state.lore.locations.findIndex(l => l.id === norm.id);
    if (idx < 0) {
      const normName = (norm.name || norm.displayName || '').trim().toLowerCase();
      if (normName) idx = this.state.lore.locations.findIndex(l => (l.name || l.displayName || '').trim().toLowerCase() === normName);
    }
    if (idx >= 0) {
      norm.id = this.state.lore.locations[idx].id;
      this.state.lore.locations[idx] = norm;
    } else {
      this.state.lore.locations.push(norm);
    }
  }

  upsertTimelineEvent(event) {
    const norm = this.normalizeTimelineEvent(event, this.state.lore.timeline.length);
    const idx = this.state.lore.timeline.findIndex(t => t.id === norm.id);
    if (idx >= 0) {
      this.state.lore.timeline[idx] = norm;
    } else {
      this.state.lore.timeline.push(norm);
    }
  }

  setupMobileKbSortables() {
    if (!this.isMobileLayout?.()) return;
    document.querySelectorAll('.mobile-tab-surface.active [data-dnd-zone], .mobile-panel [data-dnd-zone]').forEach((zone) => {
      if (zone.__sortable) return;
      this.setupKbSortable(zone);
    });
  }

  setupKbSortable(zone) {
    if (!window.Sortable) return;
    zone.querySelectorAll('[draggable]').forEach((el) => el.removeAttribute('draggable'));
    const zoneType = zone.dataset.dndZone;
    const isTimelineZone = ['timeline', 'subtimeline'].includes(zoneType);
    const mobile = this.isMobileLayout?.();
    const sortable = new window.Sortable(zone, {
      animation: mobile ? 190 : 220,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      forceFallback: true,
      fallbackOnBody: !mobile,
      fallbackClass: 'sortable-fallback-drag',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      removeCloneOnHide: true,
      delayOnTouchOnly: true,
      delay: mobile ? 190 : 0,
      touchStartThreshold: mobile ? 8 : 0,
      fallbackTolerance: mobile ? 8 : 3,
      scrollSensitivity: mobile ? 42 : 36,
      scrollSpeed: mobile ? 9 : 10,
      handle: undefined,
      filter: 'button, input, textarea, select, a, [data-action], .lore-card-actions, .mobile-lore-actions',
      preventOnFilter: false,
      onStart: (event) => {
        document.body.classList.add('sortable-active');
        if (window.Capacitor?.Plugins?.Haptics?.impact) {
          window.Capacitor.Plugins.Haptics.impact({ style: 'light' }).catch(() => {});
        }
        window.getSelection()?.removeAllRanges();
        this.kbDragState = {
          id: event.item.dataset.loreId,
          type: zoneType,
        };
        event.from.classList.add('is-dragging');
        this.updateTimelineConnectors(event.from);
      },
      onEnd: async (event) => {
        document.body.classList.remove('sortable-active');
        event.from.classList.remove('is-dragging');
        event.to.classList.remove('is-dragging');
        this.updateTimelineConnectors(event.from);
        this.updateTimelineConnectors(event.to);
        if (event.oldIndex !== event.newIndex) {
          this.kbSuppressClickUntil = Date.now() + 260;
          await this.persistKbDomOrder(zoneType, event.from);
        }
        this.kbDragState = null;
      },
    });
    zone.__sortable = sortable;
    this.kbSortables.push(sortable);
  }

  updateTimelineConnectors(zone) {
    if (!['timeline', 'subtimeline'].includes(zone?.dataset.dndZone)) return;
    const items = [...zone.querySelectorAll('.timeline-item:not(.hidden)')];
    zone.querySelectorAll('.timeline-item.last').forEach((item) => item.classList.remove('last'));
    items.at(-1)?.classList.add('last');
  }

  async persistKbDomOrder(type, zone) {
    const order = [...zone.querySelectorAll('[data-lore-id]')].map((el) => el.dataset.loreId);
    const list = type === 'subtimeline' ? this.timelineEvent(zone.dataset.parentId)?.subEvents : this.state.lore[type];
    if (!list) return;
    list.forEach((item) => {
      const index = order.indexOf(item.id);
      if (index >= 0) item.order = index;
    });
    list.sort((a, b) => a.order - b.order);
    await this.saveLore();
  }

  async mobileReorderLore(button) {
    if (!button) return;
    const type = button.dataset.loreType;
    const id = button.dataset.loreId;
    const direction = Number(button.dataset.direction || 0);
    if (!type || !id || !direction) return;
    const list = type === 'subtimeline'
      ? this.timelineEvent(button.dataset.parentId)?.subEvents
      : this.state.lore[type];
    if (!Array.isArray(list)) return;
    list.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
    const index = list.findIndex((item) => item.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= list.length) return;
    [list[index], list[nextIndex]] = [list[nextIndex], list[index]];
    list.forEach((item, order) => { item.order = order; });
    await this.saveLore();
    this.renderMobileShell();
    this.toast('Порядок обновлён.');
  }

  characterCard(item, draggable = false) {
    const visual = item.image ? `<img src="${item.image}" alt="">` : `<i class="bx ${item.icon || 'bx-user'}"></i>`;
    const isNew = this.state.newlyCreatedId === item.id;
    const entranceClass = isNew ? ' new-card-entrance' : '';
    return `<div class="char-card${entranceClass}" data-lore-type="characters" data-lore-id="${item.id}" ${draggable ? 'draggable="true"' : ''}>${this.loreCardActions('characters', item.id)}<div class="char-img">${visual}</div><div class="char-info"><h3>${escapeHtml(this.entityDisplayName(item))}</h3><p>${escapeHtml(item.role || item.body)}</p></div></div>`;
  }

  locationCard(item, draggable = false) {
    const visual = item.image ? `<img src="${escapeHtml(item.image)}" alt="">` : `<i class="bx ${escapeHtml(item.icon || 'bx-buildings')}"></i>`;
    const isNew = this.state.newlyCreatedId === item.id;
    const entranceClass = isNew ? ' new-card-entrance' : '';
    return `<div class="loc-card${entranceClass}" data-lore-type="locations" data-lore-id="${item.id}" ${draggable ? 'draggable="true"' : ''}>${this.loreCardActions('locations', item.id)}<div class="loc-img">${visual}</div><div class="loc-info"><h3>${escapeHtml(this.entityDisplayName(item))}</h3><p>${escapeHtml(item.role || item.body)}</p></div></div>`;
  }

  noteCard(item, draggable = false) {
    const isNew = this.state.newlyCreatedId === item.id;
    const entranceClass = isNew ? ' new-card-entrance' : '';
    return `<div class="char-card note-card${entranceClass}" data-lore-type="notes" data-lore-id="${item.id}" ${draggable ? 'draggable="true"' : ''}>${this.loreCardActions('notes', item.id)}<div class="char-img"><i class="bx bx-note"></i></div><div class="char-info"><h3>${escapeHtml(item.title || 'Без названия')}</h3><p>${escapeHtml(item.body || 'Пустая запись')}</p></div></div>`;
  }

  timelineCard(item, options = {}) {
    const { isLast = false, draggable = false, isSub = false, parentId = '' } = options;
    const type = isSub ? 'subtimeline' : 'timeline';
    const subCount = Array.isArray(item.subEvents) ? item.subEvents.length : 0;
    const parentAttr = parentId ? ` data-parent-id="${escapeHtml(parentId)}"` : '';

    const charBadges = (Array.isArray(item.characterIds) ? item.characterIds : []).map(charId => {
      const char = this.state.lore.characters.find(c => c.id === charId);
      if (!char) return '';
      const role = (item.characterRoles && item.characterRoles[charId]) || 'regular';
      let icon = 'bx-user';
      let roleClass = 'role-regular';
      let roleLabel = 'Участие';
      if (role === 'first_appearance') {
        icon = 'bx-star';
        roleClass = 'role-first-appearance';
        roleLabel = 'Появление';
      } else if (role === 'death') {
        icon = 'bx-skull';
        roleClass = 'role-death';
        roleLabel = 'Смерть';
      }
      return `<span class="association-badge char-badge ${roleClass}" data-action="open-lore-detail" data-entity-kind="character" data-entity-id="${char.id}" title="${roleLabel}"><i class="bx ${icon}"></i>${escapeHtml(this.entityDisplayName(char))}</span>`;
    }).filter(Boolean).join('');

    const locBadges = (Array.isArray(item.locationIds) ? item.locationIds : []).map(locId => {
      const loc = this.state.lore.locations.find(l => l.id === locId);
      if (!loc) return '';
      return `<span class="association-badge loc-badge" data-action="open-lore-detail" data-entity-kind="location" data-entity-id="${loc.id}"><i class="bx bx-map-alt"></i>${escapeHtml(this.entityDisplayName(loc))}</span>`;
    }).filter(Boolean).join('');

    const docBadges = (Array.isArray(item.chapterIds) ? item.chapterIds : []).map(docId => {
      const doc = this.state.docs.find(d => d.id === docId);
      if (!doc) return '';
      return `<span class="association-badge doc-badge" data-action="open-search-result" data-doc-id="${doc.id}"><i class="bx bx-book-content"></i>${escapeHtml(doc.title || 'Без названия')}</span>`;
    }).filter(Boolean).join('');

    const noteBadges = (Array.isArray(item.noteIds) ? item.noteIds : []).map(noteId => {
      const note = (this.state.lore.notes || []).find(n => n.id === noteId);
      if (!note) return '';
      return `<span class="association-badge note-badge" data-action="open-lore-detail" data-entity-kind="note" data-entity-id="${note.id}"><i class="bx bx-note"></i>${escapeHtml(note.title || 'Без названия')}</span>`;
    }).filter(Boolean).join('');

    const badgesHTML = (charBadges || locBadges || noteBadges || docBadges) ? `
      <div class="timeline-event-associations">
        ${charBadges}
        ${locBadges}
        ${noteBadges}
        ${docBadges}
      </div>
    ` : '';

    const isNew = this.state.newlyCreatedId === item.id;
    const entranceClass = isNew ? ' new-card-entrance' : '';

    return `<div class="timeline-item ${isLast ? 'last' : ''}${entranceClass}" data-lore-type="${type}" data-lore-id="${item.id}"${parentAttr} ${draggable ? 'draggable="true"' : ''}>
      <div class="timeline-track"><div class="timeline-dot"></div><div class="timeline-line"></div></div>
      <div class="timeline-content-wrapper">
        <div class="timeline-date">${escapeHtml(item.date)}</div>
        <div class="timeline-content">
          ${this.timelineCardActions(item, { isSub, parentId })}
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.body)}</p>
          ${badgesHTML}
          ${!isSub && subCount ? `<div class="subtimeline-count"><i class="bx bx-git-branch"></i>${subCount}</div>` : ''}
        </div>
      </div>
    </div>`;
  }

  timelineCardActions(item, { isSub = false, parentId = '' } = {}) {
    const type = isSub ? 'subtimeline' : 'timeline';
    const parentAttr = parentId ? ` data-parent-id="${escapeHtml(parentId)}"` : '';
    return `<div class="lore-card-actions timeline-actions">
      ${!isSub ? `<button type="button" data-action="open-subtimeline" data-lore-type="timeline" data-lore-id="${item.id}" title="Сабтаймлайн"><i class="bx bx-git-branch"></i></button>` : ''}
      <button type="button" data-action="dump-single-entity" data-lore-type="${type}" data-lore-id="${item.id}"${parentAttr} title="Дамп события"><i class="bx bx-download"></i></button>
      <button type="button" data-action="edit-lore" data-lore-type="${type}" data-lore-id="${item.id}"${parentAttr} title="Редактировать"><i class="bx bx-edit"></i></button>
      <button type="button" data-action="delete-lore" data-lore-type="${type}" data-lore-id="${item.id}"${parentAttr} title="Удалить"><i class="bx bx-trash"></i></button>
    </div>`;
  }

  loreCardActions(type, id) {
    const cleanerButton = type === 'notes'
      ? `<button type="button" data-action="clean-note" data-lore-id="${id}" class="cleaner-btn" title="«Чистильщик™»"><i class="reaper-icon"></i></button>`
      : '';
    return `<div class="lore-card-actions">
      ${cleanerButton}
      <button type="button" data-action="dump-single-entity" data-lore-type="${type}" data-lore-id="${id}" title="Дамп карточки"><i class="bx bx-download"></i></button>
      <button type="button" data-action="edit-lore" data-lore-type="${type}" data-lore-id="${id}" title="Редактировать"><i class="bx bx-edit"></i></button>
      <button type="button" data-action="delete-lore" data-lore-type="${type}" data-lore-id="${id}" title="Удалить"><i class="bx bx-trash"></i></button>
    </div>`;
  }

  timelineEvent(id) {
    return this.state.lore.timeline.find((event) => event.id === id) || null;
  }

  activeSubtimeline() {
    return this.timelineEvent(this.state.activeSubtimelineId);
  }

  subtimelineEvents(parent) {
    return [...(parent?.subEvents || [])].sort((a, b) => (a.order - b.order) || parseTimelineRank(a.date) - parseTimelineRank(b.date));
  }

  subtimelinePanel(parent) {
    const events = this.subtimelineEvents(parent);
    return `<div class="subtimeline-overlay active">
      <section class="subtimeline-modal" data-parent-id="${escapeHtml(parent.id)}">
        <header class="subtimeline-header">
          <div>
            <h2>Сабтаймлайн</h2>
            <p>${escapeHtml(parent.title || '')}</p>
          </div>
          <button class="btn-icon" data-action="close-subtimeline" title="Закрыть"><i class="bx bx-x"></i></button>
        </header>
        <div class="subtimeline-toolbar">
          <button class="pill-btn ai-btn" data-action="new-subtimeline-event" data-parent-id="${escapeHtml(parent.id)}"><i class="bx bx-plus"></i> Добавить саб-событие</button>
        </div>
        <div class="subtimeline-scroll">
          <div class="timeline-container subtimeline-container" data-dnd-zone="subtimeline" data-parent-id="${escapeHtml(parent.id)}">
            ${events.length
              ? events.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1, draggable: true, isSub: true, parentId: parent.id })).join('')
              : this.emptyStateMarkup('bx-git-branch', 'Вложенных событий пока нет.', 'Добавьте саб-событие, если этот эпизод нужно развернуть подробнее.')}
          </div>
        </div>
      </section>
    </div>`;
  }

  renderSubtimelineContent(parent) {
    const events = this.subtimelineEvents(parent);
    return `
      <div class="subtimeline-toolbar mobile-subtimeline-toolbar">
        <button class="pill-btn ai-btn" data-action="new-subtimeline-event" data-parent-id="${escapeHtml(parent.id)}"><i class="bx bx-plus"></i> Добавить подсобытие</button>
      </div>
      <div class="timeline-container subtimeline-container" data-dnd-zone="subtimeline" data-parent-id="${escapeHtml(parent.id)}">
        ${events.length
          ? events.map((item, i, arr) => this.timelineCard(item, { isLast: i === arr.length - 1, draggable: true, isSub: true, parentId: parent.id })).join('')
          : this.emptyStateMarkup('bx-git-branch', 'Вложенных событий пока нет.', 'Добавьте подсобытие, если этот эпизод нужно развернуть подробнее.')}
      </div>`;
  }

  openSubtimeline(id) {
    if (!this.timelineEvent(id)) return;
    this.state.activeSubtimelineId = id;
    this.state.activeKbTab = 'timeline';
    this.state.mobile.kbTab = 'timeline';
    if (this.isMobileLayout()) {
      this.switchMobileTab('lore', { keepOverlay: false });
      return;
    }
    this.renderKb();
  }

  closeSubtimeline() {
    if (!this.state.activeSubtimelineId) return;
    this.state.activeSubtimelineId = null;
    if (this.isMobileLayout()) {
      this.renderMobileShell();
      return;
    }
    this.renderKb();
  }

  openKb(tab) {
    this.state.activeKbTab = tab;
    this.state.activeLoreDetail = null;
    if (tab !== 'timeline') this.state.activeSubtimelineId = null;
    // Wipe HTML to force full re-render on open so tab switches
    const modal = document.getElementById('kb-modal');
    modal.innerHTML = ''; 
    this.renderKb();
    modal.classList.add('active');
    this.closeFloatingMenu('kb');
  }

  renderLoreEntityFields(type, item, iconOptions) {
    const iconSelect = `<select class="form-control" name="icon">${iconOptions.map(([value, label]) => `<option value="${value}" ${item.icon === value ? 'selected' : ''}>${label}</option>`).join('')}</select>`;
    const fileName = item.image ? 'Текущая картинка сохранена' : 'Файл не выбран';
    const imagePreview = item.image ? `<span class="lore-file-preview"><img src="${escapeHtml(item.image)}" alt=""></span>` : '';
    const common = `
      <label class="lore-field">Роль / тип <input class="form-control" name="role" value="${escapeHtml(item.role || '')}"></label>
      <label class="lore-field">Встроенная иконка ${iconSelect}</label>
      <label class="lore-field lore-field-wide">Алиасы через запятую <input class="form-control" name="aliases" value="${escapeHtml((item.aliases || []).join(', '))}"></label>
      <label class="lore-field lore-field-wide">Варианты упоминаний через запятую <input class="form-control" name="mentionForms" value="${escapeHtml((item.mentionForms || []).join(', '))}"><small>Сюда можно добавить склонённые формы или устойчивые варианты, например: Зейна Леранте, Зейну Леранте.</small></label>
      <label class="lore-field lore-field-wide lore-file-field">
        <span>Своя картинка</span>
        <input class="lore-file-native" type="file" name="imageFile" accept="image/*">
        <span class="lore-file-picker">
          <span class="lore-file-button"><i class="bx bx-image-add"></i> Выбрать файл</span>
          <span class="lore-file-name" data-file-name>${escapeHtml(fileName)}</span>
          ${imagePreview}
        </span>
      </label>
    `;
    if (type === 'characters') {
      const normalized = this.normalizeCharacter(item);
      return `
        <div class="lore-form-grid lore-form-grid-entity">
          <label class="lore-field">Имя <input class="form-control" name="firstName" value="${escapeHtml(normalized.firstName || '')}" required></label>
          <label class="lore-field">Фамилия <input class="form-control" name="lastName" value="${escapeHtml(normalized.lastName || '')}"></label>
          ${common}
        </div>
      `;
    }
    return `
      <div class="lore-form-grid lore-form-grid-entity">
        <label class="lore-field lore-field-wide">Название <input class="form-control" name="name" value="${escapeHtml(item.displayName || item.name || '')}" required></label>
        ${common}
      </div>
    `;
  }

  parseCsv(value = '') {
    return String(value).split(',').map((item) => item.trim()).filter(Boolean);
  }

  editLore(type, id = null, parentId = null) {
    const isSubtimeline = type === 'subtimeline';
    const parentEvent = isSubtimeline ? this.timelineEvent(parentId || this.state.activeSubtimelineId) : null;
    const collection = isSubtimeline ? parentEvent?.subEvents : this.state.lore[type];
    if (!collection) return;
    const item = id ? collection.find((entry) => entry.id === id) : {};
    if (id && !item) return;
    const isTimeline = type === 'timeline' || isSubtimeline;
    const iconOptions = [
      ['bx-user', 'Персона'],
      ['bx-face', 'Лицо'],
      ['bx-shield-quarter', 'Щит'],
      ['bx-crown', 'Корона'],
      ['bx-buildings', 'Город'],
      ['bx-tree', 'Лес'],
      ['bx-map-alt', 'Карта'],
      ['bx-castle', 'Замок'],
    ];
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <form class="form-modal lore-form-${type}" id="lore-form" novalidate>
        <h2>${id ? 'Редактировать' : 'Создать'} ${isSubtimeline ? 'саб-событие' : isTimeline ? 'событие' : 'карточку'}</h2>
        <div class="form-grid">
          ${isTimeline ? `
            <label>Дата <input class="form-control" name="date" value="${escapeHtml(item.date || 'Эпоха Пепла, год 1')}" required></label>
            <label>Название <input class="form-control" name="title" value="${escapeHtml(item.title || '')}" required></label>
          ` : type === 'notes' ? `
            <label class="lore-field lore-field-wide">Заголовок <input class="form-control" name="title" value="${escapeHtml(item.title || '')}" required></label>
          ` : this.renderLoreEntityFields(type, item, iconOptions)}
          <label class="lore-field lore-field-wide lore-description-field">Описание <textarea class="form-control" name="body" required>${escapeHtml(item.body || '')}</textarea></label>
          ${isTimeline ? `
            <div class="lore-field lore-field-wide timeline-associations-fields">
              <h4 class="associations-title"><i class="bx bx-link"></i> Привязки и Ассоциации</h4>
              <div class="assoc-tabs-header">
                <button type="button" class="assoc-tab-btn active" data-assoc-tab="char"><i class="bx bx-user"></i> Персонажи</button>
                <button type="button" class="assoc-tab-btn" data-assoc-tab="loc"><i class="bx bx-map-alt"></i> Локации</button>
                <button type="button" class="assoc-tab-btn" data-assoc-tab="note"><i class="bx bx-note"></i> Записи</button>
                <button type="button" class="assoc-tab-btn" data-assoc-tab="doc"><i class="bx bx-file"></i> Документы</button>
              </div>
              
              <div class="assoc-tab-content active" data-assoc-content="char">
                <div class="assoc-search-wrap">
                  <input type="text" class="form-control assoc-search-input" placeholder="Поиск персонажей..." data-assoc-search="char" autocomplete="off">
                </div>
                <div class="assoc-cards-grid" data-assoc-grid="char">
                  ${this.state.lore.characters.map(char => {
                    const checked = Array.isArray(item.characterIds) && item.characterIds.includes(char.id);
                    const role = (item.characterRoles && item.characterRoles[char.id]) || 'regular';
                    const roleLabel = role === 'first_appearance' ? 'Появление' : role === 'death' ? 'Смерть' : 'Участие';
                    return `
                      <div class="assoc-card char-assoc-card ${checked ? 'active' : ''}" data-id="${char.id}" data-role="${role}">
                        <div class="assoc-card-main">
                          <span class="assoc-card-icon"><i class="bx ${char.icon || 'bx-user'}"></i></span>
                          <div class="assoc-card-details">
                            <span class="assoc-card-title">${escapeHtml(this.entityDisplayName(char))}</span>
                            <span class="assoc-card-role-label">${roleLabel}</span>
                          </div>
                        </div>
                        <div class="assoc-card-role-selector">
                          <button type="button" class="role-btn ${role === 'regular' ? 'active' : ''}" data-role="regular" title="Участие">Участ.</button>
                          <button type="button" class="role-btn ${role === 'first_appearance' ? 'active' : ''}" data-role="first_appearance" title="Появление">Появл.</button>
                          <button type="button" class="role-btn ${role === 'death' ? 'active' : ''}" data-role="death" title="Смерть">Смерть</button>
                        </div>
                        <input type="checkbox" name="char_assoc_${char.id}" ${checked ? 'checked' : ''} style="display:none">
                        <input type="hidden" name="char_role_${char.id}" value="${role}" class="assoc-hidden-role">
                      </div>
                    `;
                  }).join('') || '<div class="empty-state-text">Нет персонажей</div>'}
                </div>
              </div>
              
              <div class="assoc-tab-content" data-assoc-content="loc">
                <div class="assoc-search-wrap">
                  <input type="text" class="form-control assoc-search-input" placeholder="Поиск локаций..." data-assoc-search="loc" autocomplete="off">
                </div>
                <div class="assoc-cards-grid" data-assoc-grid="loc">
                  ${this.state.lore.locations.map(loc => {
                    const checked = Array.isArray(item.locationIds) && item.locationIds.includes(loc.id);
                    return `
                      <div class="assoc-card loc-assoc-card ${checked ? 'active' : ''}" data-id="${loc.id}">
                        <div class="assoc-card-main">
                          <span class="assoc-card-icon"><i class="bx ${loc.icon || 'bx-map-alt'}"></i></span>
                          <span class="assoc-card-title">${escapeHtml(this.entityDisplayName(loc))}</span>
                        </div>
                        <input type="checkbox" name="loc_assoc_${loc.id}" ${checked ? 'checked' : ''} style="display:none">
                      </div>
                    `;
                  }).join('') || '<div class="empty-state-text">Нет локаций</div>'}
                </div>
              </div>

              <div class="assoc-tab-content" data-assoc-content="note">
                <div class="assoc-search-wrap">
                  <input type="text" class="form-control assoc-search-input" placeholder="Поиск записей..." data-assoc-search="note" autocomplete="off">
                </div>
                <div class="assoc-cards-grid" data-assoc-grid="note">
                  ${(this.state.lore.notes || []).map(note => {
                    const checked = Array.isArray(item.noteIds) && item.noteIds.includes(note.id);
                    return `
                      <div class="assoc-card note-assoc-card ${checked ? 'active' : ''}" data-id="${note.id}">
                        <div class="assoc-card-main">
                          <span class="assoc-card-icon"><i class="bx bx-note"></i></span>
                          <span class="assoc-card-title">${escapeHtml(note.title || 'Без названия')}</span>
                        </div>
                        <input type="checkbox" name="note_assoc_${note.id}" ${checked ? 'checked' : ''} style="display:none">
                      </div>
                    `;
                  }).join('') || '<div class="empty-state-text">Нет записей</div>'}
                </div>
              </div>
              
              <div class="assoc-tab-content" data-assoc-content="doc">
                <div class="assoc-search-wrap">
                  <input type="text" class="form-control assoc-search-input" placeholder="Поиск документов..." data-assoc-search="doc" autocomplete="off">
                </div>
                <div class="assoc-cards-grid" data-assoc-grid="doc">
                  ${this.state.docs.map(doc => {
                    const checked = Array.isArray(item.chapterIds) && item.chapterIds.includes(doc.id);
                    return `
                      <div class="assoc-card doc-assoc-card ${checked ? 'active' : ''}" data-id="${doc.id}">
                        <div class="assoc-card-main">
                          <span class="assoc-card-icon"><i class="bx bx-file"></i></span>
                          <span class="assoc-card-title">${escapeHtml(doc.title || 'Без названия')}</span>
                        </div>
                        <input type="checkbox" name="doc_assoc_${doc.id}" ${checked ? 'checked' : ''} style="display:none">
                      </div>
                    `;
                  }).join('') || '<div class="empty-state-text">Нет документов</div>'}
                </div>
              </div>
            </div>
          ` : ''}
        </div>
        <div class="form-actions lore-form-actions">
          ${id ? '<button class="pill-btn" type="button" data-delete-lore>Удалить</button>' : ''}
          <button class="pill-btn" type="button" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" type="submit">Сохранить</button>
        </div>
      </form>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    
    // Tab switching behavior
    overlay.querySelectorAll('.assoc-tab-btn').forEach(btn => {
      btn.onclick = () => {
        overlay.querySelectorAll('.assoc-tab-btn').forEach(b => b.classList.remove('active'));
        overlay.querySelectorAll('.assoc-tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.assocTab;
        overlay.querySelector(`[data-assoc-content="${tab}"]`).classList.add('active');
      };
    });

    overlay.querySelectorAll('.assoc-card').forEach(card => {
      card.onclick = (e) => {
        const roleBtn = e.target.closest('.role-btn');
        if (roleBtn) {
          e.stopPropagation();
          const role = roleBtn.dataset.role;
          card.querySelector('.assoc-hidden-role').value = role;
          card.dataset.role = role;
          const roleLabel = card.querySelector('.assoc-card-role-label');
          if (roleLabel) {
            roleLabel.textContent = role === 'first_appearance' ? 'Появление' : role === 'death' ? 'Смерть' : 'Участие';
          }
          card.querySelectorAll('.role-btn').forEach(btn => btn.classList.toggle('active', btn === roleBtn));
          return;
        }
        const checkbox = card.querySelector('input[type="checkbox"]');
        checkbox.checked = !checkbox.checked;
        card.classList.toggle('active', checkbox.checked);
      };
    });
    // Search filter for association columns (Item 3)
    overlay.querySelectorAll('.assoc-search-input').forEach(input => {
      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const gridType = input.dataset.assocSearch;
        const grid = overlay.querySelector(`[data-assoc-grid="${gridType}"]`);
        if (!grid) return;
        grid.querySelectorAll('.assoc-card').forEach(card => {
          const title = card.querySelector('.assoc-card-title')?.textContent?.toLowerCase() || '';
          card.style.display = !q || title.includes(q) ? '' : 'none';
        });
      });
    });
    overlay.querySelector('[data-delete-lore]')?.addEventListener('click', async () => {
      overlay.classList.remove('active');
      const cardEl = document.querySelector(`[data-lore-id="${id}"]`);
      let shatterEl = cardEl;
      if ((type === 'timeline' || type === 'subtimeline') && cardEl) {
        shatterEl = cardEl.querySelector('.timeline-content') || cardEl;
      }
      this.animateShatter(shatterEl, async () => {
        if (cardEl) {
          const parentGrid = cardEl.parentElement;
          cardEl.remove();
          if (parentGrid && parentGrid.children.length === 0) {
            const typeClassMap = {
              characters: { icon: 'bx-user-pin', title: 'Персонажей пока нет.', desc: 'Создайте первый профиль, чтобы Nocturne начал узнавать имена в тексте.', action: 'new-lore', btnText: 'Создать профиль', attr: 'data-lore-type="characters"' },
              locations: { icon: 'bx-map-alt', title: 'Локации пока нет.', desc: 'Добавьте первое место мира или сцены.', action: 'new-lore', btnText: 'Добавить место', attr: 'data-lore-type="locations"' },
              notes: { icon: 'bx-note', title: 'Записей пока нет.', desc: 'Добавьте первую свободную запись или заметку к миру.', action: 'new-lore', btnText: 'Создать запись', attr: 'data-lore-type="notes"' },
              timeline: { icon: 'bx-git-commit', title: 'Хронология пока пуста.', desc: 'Добавьте первое событие, чтобы выстроить историю.', action: 'new-lore', btnText: 'Добавить событие', attr: 'data-lore-type="timeline"' }
            };
            const config = typeClassMap[type];
            if (config) {
              parentGrid.innerHTML = this.emptyStateMarkup(config.icon, config.title, config.desc, config.action, config.btnText, config.attr);
            }
          }
        }
        await this.deleteLore(type, id, parentEvent?.id, true);
      });
    });
    overlay.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      if (!this.validateForm(event.target)) return;
      const data = Object.fromEntries(new FormData(event.target));
      let image = item.image || '';
      const file = event.target.elements.imageFile?.files?.[0];
      if (file) image = await this.fileToDataUrl(file);
      const existingDocs = Array.isArray(item.documentIds) && item.documentIds.length ? item.documentIds : [this.state.activeDocId].filter(Boolean);
      const order = Number.isFinite(Number(item.order)) ? Number(item.order) : collection.length;
      let next;
      if (isTimeline) {
        const characterIds = [];
        const characterRoles = {};
        const locationIds = [];
        const noteIds = [];
        const chapterIds = [];
        this.state.lore.characters.forEach(char => {
          if (event.target.elements[`char_assoc_${char.id}`]?.checked) {
            characterIds.push(char.id);
            characterRoles[char.id] = event.target.elements[`char_role_${char.id}`]?.value || 'regular';
          }
        });
        this.state.lore.locations.forEach(loc => {
          if (event.target.elements[`loc_assoc_${loc.id}`]?.checked) {
            locationIds.push(loc.id);
          }
        });
        (this.state.lore.notes || []).forEach(note => {
          if (event.target.elements[`note_assoc_${note.id}`]?.checked) {
            noteIds.push(note.id);
          }
        });
        this.state.docs.forEach(doc => {
          if (event.target.elements[`doc_assoc_${doc.id}`]?.checked) {
            chapterIds.push(doc.id);
          }
        });
        next = {
          id: id || uid(isSubtimeline ? 'subtime' : 'time'),
          date: data.date,
          title: data.title,
          body: data.body,
          documentIds: existingDocs,
          order,
          subEvents: isSubtimeline ? [] : (item.subEvents || []),
          characterIds,
          characterRoles,
          locationIds,
          noteIds,
          chapterIds
        };
      } else if (type === 'characters') {
        const firstName = String(data.firstName || '').trim();
        const lastName = String(data.lastName || '').trim();
        const displayName = `${firstName} ${lastName}`.trim();
        next = this.normalizeCharacter({
          ...item,
          id: id || uid('char'),
          firstName,
          lastName,
          displayName,
          name: displayName,
          role: data.role,
          body: data.body,
          icon: data.icon,
          image,
          aliases: this.parseCsv(data.aliases),
          mentionForms: this.parseCsv(data.mentionForms),
          documentIds: existingDocs,
          order,
        }, order);
      } else if (type === 'notes') {
        next = this.normalizeNote({
          ...item,
          id: id || uid('note'),
          title: data.title,
          body: data.body,
          order,
        }, order);
      } else {
        next = this.normalizeLocation({
          ...item,
          id: id || uid('loc'),
          name: data.name,
          displayName: data.name,
          role: data.role,
          body: data.body,
          icon: data.icon,
          image,
          aliases: this.parseCsv(data.aliases),
          mentionForms: this.parseCsv(data.mentionForms),
          documentIds: existingDocs,
          order,
        }, order);
      }
      if (id) Object.assign(item, next);
      else {
        collection.push(next);
        this.state.kbSearch = '';
        this.state.newlyCreatedId = next.id;
      }
      overlay.classList.remove('active');
      setTimeout(async () => {
        await this.saveLore();
        this.refreshVisibleEntityLinks();
        
        const modal = document.getElementById('kb-modal');
        const isModalOpen = modal && modal.classList.contains('active');
        const isDetailView = this.state.activeLoreDetail !== null;

        if (!id && isModalOpen && !isDetailView && this.state.activeKbTab === type) {
          let gridSelector = '';
          if (type === 'characters') gridSelector = '.character-grid[data-dnd-zone="characters"]';
          if (type === 'locations') gridSelector = '.locations-grid[data-dnd-zone="locations"]';
          if (type === 'notes') gridSelector = '.character-grid[data-dnd-zone="notes"]';
          if (type === 'timeline') gridSelector = '.timeline-container[data-dnd-zone="timeline"]';

          const grid = document.querySelector(gridSelector);
          if (grid) {
            const hasEmptyState = grid.querySelector('.kb-empty-state') || grid.querySelector('.empty-card') || grid.innerHTML.includes('пока нет');
            if (hasEmptyState) {
              grid.innerHTML = '';
            }

            let cardHtml = '';
            if (type === 'characters') cardHtml = this.characterCard(next, true);
            if (type === 'locations') cardHtml = this.locationCard(next, true);
            if (type === 'notes') cardHtml = this.noteCard(next, true);
            if (type === 'timeline') cardHtml = this.timelineCard(next, { isLast: true, draggable: true });

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = cardHtml.trim();
            const cardElement = tempDiv.firstChild;
            if (cardElement) {
              cardElement.classList.add('new-card-entrance');
              grid.appendChild(cardElement);
              
              // Re-initialize SortableJS to register the new item
              this.setupKbDragDrop();
              
              setTimeout(() => {
                cardElement.classList.remove('new-card-entrance');
                if (this.state.newlyCreatedId === next.id) {
                  this.state.newlyCreatedId = null;
                }
              }, 1000);
            }
          } else {
            this.renderKb();
          }
        } else {
          this.renderKb();
        }
      }, 100);
    };
  }

  confirmDeleteLore(type, id, parentId = null) {
    const isSubtimeline = type === 'subtimeline';
    const parentEvent = isSubtimeline ? this.timelineEvent(parentId || this.state.activeSubtimelineId) : null;
    const collection = isSubtimeline ? parentEvent?.subEvents : this.state.lore[type];
    const item = collection?.find((entry) => entry.id === id);
    if (!item) return;
    const label = this.entityDisplayName(item) || item.title || 'элемент';
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-trash"></i></div>
        <h2>Удалить карточку?</h2>
        <p>«${escapeHtml(label)}» будет удалена из базы знаний.</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn danger-btn" data-confirm-delete-lore>Удалить</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-confirm-delete-lore]').onclick = async () => {
      overlay.classList.remove('active');
      const cardEl = document.querySelector(`[data-lore-id="${id}"]`);
      let shatterEl = cardEl;
      if ((type === 'timeline' || type === 'subtimeline') && cardEl) {
        shatterEl = cardEl.querySelector('.timeline-content') || cardEl;
      }
      this.animateShatter(shatterEl, async () => {
        if (cardEl) {
          const parentGrid = cardEl.parentElement;
          this.animateLayoutTransition(parentGrid, () => {
            cardEl.remove();
            if (parentGrid && parentGrid.children.length === 0) {
              const typeClassMap = {
                characters: { icon: 'bx-user-pin', title: 'Персонажей пока нет.', desc: 'Создайте первый профиль, чтобы Nocturne начал узнавать имена в тексте.', action: 'new-lore', btnText: 'Создать профиль', attr: 'data-lore-type="characters"' },
                locations: { icon: 'bx-map-alt', title: 'Локации пока нет.', desc: 'Добавьте первое место мира или сцены.', action: 'new-lore', btnText: 'Добавить место', attr: 'data-lore-type="locations"' },
                notes: { icon: 'bx-note', title: 'Записей пока нет.', desc: 'Добавьте первую свободную запись или заметку к миру.', action: 'new-lore', btnText: 'Создать запись', attr: 'data-lore-type="notes"' },
                timeline: { icon: 'bx-git-commit', title: 'Хронология пока пуста.', desc: 'Добавьте первое событие, чтобы выстроить историю.', action: 'new-lore', btnText: 'Добавить событие', attr: 'data-lore-type="timeline"' }
              };
              const config = typeClassMap[type];
              if (config) {
                parentGrid.innerHTML = this.emptyStateMarkup(config.icon, config.title, config.desc, config.action, config.btnText, config.attr);
              }
            }
          });
        }
        await this.deleteLore(type, id, parentEvent?.id, true);
      });
    };
  }

  async deleteLore(type, id, parentId = null, localOnly = false) {
    if (type === 'subtimeline') {
      const parentEvent = this.timelineEvent(parentId || this.state.activeSubtimelineId);
      if (!parentEvent?.subEvents) return;
      parentEvent.subEvents = parentEvent.subEvents.filter((entry) => entry.id !== id).map((entry, order) => ({ ...entry, order }));
      await this.saveLore();
      this.renderKb();
      this.refreshVisibleEntityLinks();
      return;
    }
    if (!this.state.lore[type]) return;
    this.state.lore[type] = this.state.lore[type].filter((entry) => entry.id !== id).map((entry, order) => ({ ...entry, order }));
    if (type === 'characters') await this.deleteFloatingNotesForLink('character', id);
    if (type === 'locations') await this.deleteFloatingNotesForLink('location', id);
    if (type === 'notes') {
      (this.state.lore.timeline || []).forEach(evt => {
        if (Array.isArray(evt.noteIds)) evt.noteIds = evt.noteIds.filter(nid => nid !== id);
        if (Array.isArray(evt.subEvents)) {
          evt.subEvents.forEach(sub => {
            if (Array.isArray(sub.noteIds)) sub.noteIds = sub.noteIds.filter(nid => nid !== id);
          });
        }
      });
    }
    if (type === 'timeline') {
      if (this.state.activeSubtimelineId === id || !this.timelineEvent(this.state.activeSubtimelineId)) this.state.activeSubtimelineId = null;
      Object.values(this.state.workspace?.panes || {}).forEach((pane) => {
        if (pane.subtimelineParentId === id) pane.subtimelineParentId = null;
      });
    }
    let detailActive = false;
    if (this.state.activeLoreDetail?.id === id) {
      this.state.activeLoreDetail = null;
      detailActive = true;
    }
    await this.saveLore();
    if (!localOnly || detailActive) {
      this.renderKb();
    }
    this.refreshVisibleEntityLinks();
  }

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async saveLore() {
    this.state.lore.characters = (this.state.lore.characters || []).map((item, index) => this.normalizeCharacter(item, index));
    this.state.lore.locations = (this.state.lore.locations || []).map((item, index) => this.normalizeLocation(item, index));
    this.state.lore.timeline = (this.state.lore.timeline || []).map((item, index) => this.normalizeTimelineEvent(item, index));
    this.state.lore.notes = (this.state.lore.notes || []).map((item, index) => this.normalizeNote(item, index));
    if (this.state.activeSubtimelineId && !this.timelineEvent(this.state.activeSubtimelineId)) this.state.activeSubtimelineId = null;
    await this.db.put('lore', { id: 'world', ...this.state.lore });
    this.updateTypoHighlightsDebounced();
  }

  renderSettings() {
    const tabs = [
      ['search', 'bx-search', 'Поиск настроек'],
      ['visual', 'bx-palette', 'Визуал и UI'],
      ['editor', 'bx-text', 'Микро-типографика'],
      ['dictionary', 'bx-book-content', 'Словарь ошибок'],
      ['review', 'bx-edit-alt', 'Редактура'],
      ['focus', 'bx-target-lock', 'Фокус и продуктивность'],
      ['macros', 'bx-code-alt', 'Макросы'],
      ['ai', 'bx-bot', 'Продвинутый ИИ'],
      ['data', 'bx-shield-quarter', 'Данные'],
      ['export', 'bx-export', 'Экспорт'],
      ['misc', 'bx-slider-alt', 'Прочее'],
    ];
    const active = this.state.activeSettingsTab;
    document.getElementById('settings-overlay').innerHTML = `
      <div class="settings-modal">
        <aside class="settings-sidebar">
          <div class="settings-sidebar-title">Настройки</div>
          ${tabs.map(([id, icon, label]) => `<div class="settings-tab ${active === id ? 'active' : ''}" data-settings-tab="${id}"><i class="bx ${icon}"></i> ${label}</div>`).join('')}
        </aside>
        <main class="settings-body">
          <div class="settings-header"><h2>${tabs.find(([id]) => id === active)?.[2] || 'Настройки'}</h2><button class="btn-icon" data-action="close-settings"><i class="bx bx-x"></i></button></div>
          ${this.settingsContent(active)}
        </main>
      </div>
    `;
    this.updateRangeControls();
    this.updateAccentPickerControls();
    if (active === 'search') {
      setTimeout(() => {
        const field = document.getElementById('settings-search-field');
        if (field) {
          field.focus();
          const val = field.value;
          field.value = '';
          field.value = val;
        }
      }, 0);
    }
  }

  openSettingsTab(tab = 'visual') {
    this.state.activeSettingsTab = tab;
    this.closeAllFloatingMenus();
    if (this.isMobileLayout()) {
      this.state.mobile.settingsTab = ['visual', 'editor', 'dictionary', 'review', 'focus', 'macros', 'ai', 'data', 'export', 'misc', 'search'].includes(tab) ? tab : null;
      this.openMobilePanel('settings', 'more');
      return;
    }
    document.getElementById('settings-overlay')?.classList.add('active');
    this.renderSettings();
  }

  accentPresets() {
    return ['#8B5CF6', '#A855F7', '#0EA5E9', '#22C55E', '#F59E0B', '#EF4444'];
  }

  renderAccentColorControl() {
    const accent = this.normalizeAccentHex(this.state.settings.accent) || defaultSettings.accent;
    return `
      <div class="accent-picker" data-accent-picker style="--accent-preview:${escapeHtml(accent)}">
        <label class="accent-swatch" title="Выбрать цвет">
          <input type="color" value="${escapeHtml(accent)}" data-accent-native aria-label="Выбрать акцентный цвет">
          <span class="accent-swatch-orb"></span>
        </label>
        <div class="accent-picker-main">
          <div class="accent-hex-shell">
            <span>#</span>
            <input value="${escapeHtml(accent.slice(1))}" maxlength="6" spellcheck="false" data-accent-hex aria-label="HEX акцентного цвета">
          </div>
          <div class="accent-presets" aria-label="Пресеты акцентного цвета">
            ${this.accentPresets().map((color) => `<button type="button" class="accent-preset ${color.toUpperCase() === accent ? 'active' : ''}" style="--preset:${escapeHtml(color)}" data-action="set-accent-preset" data-accent-value="${escapeHtml(color)}" aria-label="Акцент ${escapeHtml(color)}"></button>`).join('')}
            <button type="button" class="accent-reset" data-action="reset-accent">Сброс</button>
          </div>
        </div>
      </div>`;
  }

  normalizeAccentHex(value = '') {
    const clean = String(value || '').trim();
    const match = clean.match(/^#?([0-9a-f]{6})$/i);
    return match ? `#${match[1].toUpperCase()}` : '';
  }

  handleAccentInput(input) {
    const raw = input.matches('[data-accent-hex]') ? `#${input.value}` : input.value;
    const color = this.normalizeAccentHex(raw);
    const picker = input.closest('[data-accent-picker]');
    picker?.classList.toggle('invalid', !color);
    if (!color) return false;
    return this.setAccentColor(color, { source: input });
  }

  setAccentColor(value, options = {}) {
    const color = this.normalizeAccentHex(value);
    if (!color) return false;
    this.state.settings.accent = color;
    this.applySettings();
    this.persistSettings();
    this.updateAccentPickerControls(options.root || document);
    return true;
  }

  updateAccentPickerControls(root = document) {
    const color = this.normalizeAccentHex(this.state.settings.accent) || defaultSettings.accent;
    root.querySelectorAll?.('[data-accent-picker]').forEach((picker) => {
      picker.style.setProperty('--accent-preview', color);
      picker.classList.remove('invalid');
      const native = picker.querySelector('[data-accent-native]');
      if (native && native.value.toUpperCase() !== color) native.value = color;
      const hex = picker.querySelector('[data-accent-hex]');
      if (hex && `#${hex.value}`.toUpperCase() !== color) hex.value = color.slice(1);
      picker.querySelectorAll('[data-accent-value]').forEach((button) => {
        button.classList.toggle('active', this.normalizeAccentHex(button.dataset.accentValue) === color);
      });
    });
  }

  settingsContent(tab) {
    const s = this.state.settings;
    const row = (label, note, control) => `<div class="setting-row"><div class="setting-info"><span>${label}${note ? `<i class="bx bx-info-circle info-icon" tabindex="0" data-tip="${escapeHtml(note)}"></i>` : ''}</span>${note ? `<small>${note}</small>` : ''}</div><div class="setting-control">${control}</div></div>`;
    const toggle = (key) => `<div class="toggle ${s[key] ? 'on' : ''}" data-setting="${key}" data-kind="toggle"></div>`;
    const range = (key, min, max, step = 1, suffix = '') => `<div class="range-field" data-range-field><input class="range-control" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-setting="${key}" data-suffix="${escapeHtml(suffix)}"><span class="range-value">${s[key]}${suffix}</span></div>`;
    const select = (key, options) => this.renderSettingsSelect(key, options);
    const input = (key, type = 'text') => `<input class="form-control" type="${type}" value="${escapeHtml(s[key] || '')}" data-setting="${key}">`;
    const content = {
      visual: `
        <div class="tab-content active">
          ${row('Тема оформления', 'Меняет базовую палитру интерфейса без изменения структуры документов.', select('theme', [['nocturne', 'Nocturne Dark'], ['midnight', 'Deep Midnight'], ['paper', 'Paper Light'], ['matrix', 'Cyberpunk Matrix'], ['lavender', 'Lavender Bloom'], ['crimson', 'Crimson Flame']]))}
          ${row('Кастомный акцентный цвет', 'Обновляет кнопки, свечения и подсветку сущностей.', this.renderAccentColorControl())}
          ${row('Прозрачность окна / Blur', 'В веб-версии включает CSS-материал; desktop bridge сможет подключить Mica/Vibrancy.', toggle('windowMaterial'))}
          ${row('Свечение курсора', 'Добавляет мягкую подсветку вокруг позиции ввода, чтобы легче держать фокус на строке.', toggle('cursorGlow'))}
          ${row('Стиль каретки', 'Выберите форму курсора ввода: тонкая линия, блок или нижнее подчёркивание.', select('caretStyle', [['line', 'Тонкая линия'], ['block', 'Блок'], ['underline', 'Подчеркивание']]))}
          ${row('Скорость мигания', 'Интервал мигания кастомной каретки в миллисекундах.', range('caretBlink', 250, 1400, 10, 'ms'))}
          ${row('Плавное дыхание каретки', 'Добавляет еле заметную анимацию каретки вместо резкого мигания.', toggle('caretBreath'))}
          ${row('Уровень контрастности текста', 'Поднимает или снижает яркость текста на странице, не меняя тему целиком.', range('textContrast', 45, 100, 1, '%'))}
          ${row('Компактный режим панелей', 'Сужает боковые панели и плотнее собирает служебный интерфейс.', toggle('compactPanels'))}
          ${row('Режим пишущей машинки', 'Держит активную строку вертикально по центру экрана — как в профессиональных редакторах.', toggle('typewriterMode'))}
          ${(this.isAndroidRuntime() || this.isCapacitorRuntime()) ? row('Уменьшить анимации на телефоне', 'По умолчанию мобильные анимации включены. Включите это только если устройство заметно тормозит.', toggle('reduceMobileAnimations')) : ''}
          ${this.isMobileLayout() ? '' : row('Горячие клавиши', 'Открывает справку по реально доступным сочетаниям клавиш.', `<button class="pill-btn" data-action="open-shortcuts"><i class="bx bx-keyboard"></i> Показать</button>`)}
        </div>`,
      editor: `
        <div class="tab-content active">
          ${(() => {
            const presetFonts = [
              ['Lora', 'Lora (Serif)'],
              ['Georgia', 'Georgia (Classic)'],
              ['Manrope', 'Manrope (Sans)'],
              ['Inter', 'Inter (Modern)'],
              ['Playfair Display', 'Playfair Display (Elegant)'],
              ['Merriweather', 'Merriweather (Readability)'],
              ['Courier New', 'Courier New (Monospace)'],
            ];
            const customFonts = (s.customFonts || []).map((f) => [f.name, f.name]);
            return row('Шрифт рукописи', 'Меняет семейство шрифта только в рабочей рукописи, не в интерфейсе.', select('fontFamily', [...presetFonts, ...customFonts]));
          })()}
          <div class="setting-row">
            <div class="setting-info">
              <span>Добавить свой шрифт <i class="bx bx-info-circle info-icon" tabindex="0" data-tip="Загрузите файл шрифта .woff2, .woff, .ttf или .otf."></i></span>
              <small>Поддерживаемые форматы: .woff2, .woff, .ttf, .otf</small>
            </div>
            <div class="setting-control">
              <label class="pill-btn file-upload-label" style="cursor: pointer; display: inline-flex; align-items: center; gap: 6px; user-select: none;">
                <i class="bx bx-upload"></i> Выбрать файл
                <input type="file" id="custom-font-uploader" accept=".woff2,.woff,.ttf,.otf" style="display: none;">
              </label>
            </div>
          </div>
          ${(s.customFonts || []).length ? `
            <div class="setting-row" style="flex-direction: column; align-items: stretch; gap: 6px;">
              <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.5px;">Загруженные шрифты</div>
              <div style="display: flex; flex-direction: column; gap: 6px;">
                ${(s.customFonts || []).map((f, idx) => `
                  <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(var(--accent-rgb), 0.05); border: 1px solid rgba(var(--accent-rgb), 0.15); padding: 6px 12px; border-radius: 6px;">
                    <span style="font-family: '${f.name}', sans-serif; font-size: 13px;">${escapeHtml(f.name)}</span>
                    <button class="btn-icon" data-action="delete-custom-font" data-font-idx="${idx}" title="Удалить" style="color: var(--accent);"><i class="bx bx-trash"></i></button>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
          ${row('Размер шрифта', 'Базовый размер текста на странице редактора.', range('fontSize', 14, 26, 1, 'px'))}
          ${row('Межстрочный интервал', 'Высота строки. Большие значения дают больше воздуха для вычитки.', range('lineHeight', 1.35, 2.25, .05))}
          ${row('Межбуквенный интервал', 'Дополнительный трекинг между буквами для комфортного чтения.', range('letterSpacing', 0, 1.8, .1, 'px'))}
          ${row('Отступ между абзацами', 'Вертикальный интервал после абзаца в em относительно текущего шрифта.', range('paragraphSpacing', .25, 2.2, .05, 'em'))}
          ${row('Абзацный отступ', 'Добавляет красную строку в прозе вместо разделения только вертикальным отступом.', toggle('paragraphIndent'))}
          ${row('Умная пунктуация', 'Заменяет --, ..., прямые кавычки на типографские символы.', toggle('smartPunctuation'))}
          ${row('Подсветка синтаксиса писателя', 'Диалоги и мысли получают отдельный визуальный слой.', toggle('writerSyntax'))}
          ${row('Ритм чтения', 'Длинные предложения подсвечиваются красным, короткие зеленым.', toggle('readability'))}
          ${row('Проверка частых ошибок', 'Локальная точечная проверка распространённых опечаток и неправильных написаний без браузерной волнистой мясорубки. Имена, фамилии и названия из Базы знаний не считаются ошибками.', toggle('strictSpellcheck'))}
          ${row('Типографская сетка', 'Показывает ритмическую направляющую строк для оценки вертикального набора.', toggle('baselineGrid'))}
        </div>`,
      dictionary: this.dictionarySettingsContent(),
      review: this.reviewSettingsContent(),
      misc: this.miscSettingsContent(),
      focus: `
        <div class="tab-content active">
          ${row('Показывать кнопку «Дзен» в верхней панели', 'Добавляет кнопку быстрого входа в режим концентрации. При выключении кнопка скрывается из toolbar.', toggle('showZenButton'))}
          ${row('Фокус на предложении / абзаце', 'Приглушает соседний текст и помогает вычитывать текущий фрагмент.', toggle('sentenceFocus'))}
          ${row('Пагинация MS Word (Экспериментально)', 'Разбивает ваш текст на страницы визуально, симулируя печатный лист. Может вызывать баги при быстром наборе текста на стыке страниц.', toggle('autoPaginate'))}
          ${row('Линейки страниц', 'Показывает тонкие направляющие полей и рабочей области страницы.', toggle('showPageRulers'))}
          ${row('Звуки клавиш (Экспериментально)', 'Мягкий тихий щелчок синтезатора при наборе текста.', toggle('typewriterSound'))}
          ${row('Анимация письма', 'Искры, волна, туман или отключение анимации ввода.', select('writingAnimation', [['sparkles', 'Искры'], ['ripple', 'Волна'], ['mist', 'Туман'], ['off', 'Выключено']]))}
          ${row('Дневная цель слов', 'Количество слов, к которому стремится дневной прогресс в нижней части sidebar.', range('dailyGoal', 100, 10000, 100))}
                              ${row('Show, Don’t Tell анализатор', 'Локально подсвечивает слабые слова и места, где фразу можно показать действием.', toggle('showDontTell'))}
          ${row('Фокус-линза', 'Позволяет временно выделить диалоги или описания и приглушить остальной текст.', select('dialogueLens', [['off', 'Выключено'], ['dialogues', 'Только диалоги'], ['descriptions', 'Только описания']]))}
        </div>`,
      ai: `
        <div class="tab-content active">
          ${this.aiPresetsContent()}
          <div class="setting-group-title">Провайдер</div>
          ${row('LLM Provider', 'Режим «Не настроен» ничего не генерирует. Для локальной модели используйте Ollama, для облачных провайдеров укажите endpoint, model и ключ.', select('aiProvider', [['local', 'Не настроен / без генерации'], ['ollama', 'Ollama'], ['groq', 'Groq free tier'], ['gemini', 'Gemini free tier'], ['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic-compatible']]))}
          ${row('Endpoint', 'Адрес API выбранного провайдера. У Ollama это локальный endpoint, у облачных сервисов — HTTPS API.', input('aiEndpoint'))}
          ${row('API Key', 'Ключ хранится локально в настройках браузера. Для Ollama обычно не нужен.', input('aiKey', 'password'))}
          ${row('Model', 'Идентификатор модели, который понимает выбранный провайдер.', input('aiModel'))}
          ${row('Проверка подключения', 'Отправляет минимальный тестовый запрос текущему провайдеру.', `<button class="pill-btn" data-action="test-ai-connection"><i class="bx bx-plug"></i> Проверить подключение</button>`)}
          <div class="setting-group-title">Поведение</div>
          ${row('Персона редактора', '', select('aiPersona', [['critic', 'Злой критик'], ['muse', 'Муза'], ['coauthor', 'Соавтор']]))}
          ${row('Креативность', 'Температура запроса: ниже — предсказуемее, выше — свободнее формулировки.', range('aiTemperature', 0, 1.4, .05))}
          ${row('Контекст базы знаний', 'Передаёт ассистенту релевантных персонажей, локации, таймлайн, сабтаймлайны и заметки как справочный контекст, не вставляя его в документ.', toggle('aiKnowledgeContext'))}
          ${row('Группы контекста', 'Можно отключить отдельные части контекста для более коротких запросов.', `
            <div class="context-settings-grid">
              <label class="nocturne-check"><input type="checkbox" data-setting="aiContextCharacters" ${s.aiContextCharacters ? 'checked' : ''}><span class="check-mark"></span><span>Characters</span></label>
              <label class="nocturne-check"><input type="checkbox" data-setting="aiContextLocations" ${s.aiContextLocations ? 'checked' : ''}><span class="check-mark"></span><span>Locations</span></label>
              <label class="nocturne-check"><input type="checkbox" data-setting="aiContextTimeline" ${s.aiContextTimeline ? 'checked' : ''}><span class="check-mark"></span><span>Timeline</span></label>
              <label class="nocturne-check"><input type="checkbox" data-setting="aiContextSubtimelines" ${s.aiContextSubtimelines ? 'checked' : ''}><span class="check-mark"></span><span>Subtimelines</span></label>
              <label class="nocturne-check"><input type="checkbox" data-setting="aiContextNotes" ${s.aiContextNotes ? 'checked' : ''}><span class="check-mark"></span><span>Notes</span></label>
            </div>`) }
          ${row('Строгость хранителя лора', 'Насколько жёстко локальная проверка реагирует на противоречия с Базой знаний.', range('loreStrictness', 0, 100, 1, '%'))}
          ${row('Реакция на конфликт лора', 'Soft только подсказывает, warn предупреждает, hard может блокировать сохранение проблемного абзаца.', select('loreReaction', [['soft', 'Подсказать'], ['warn', 'Предупредить'], ['hard', 'Блокировать сохранение абзаца']]))}
          ${row('Sentiment Timeline', 'Показывает локальную кривую эмоциональной напряжённости по последним предложениям сцены.', toggle('sentimentTimeline'))}
        </div>`,
      data: `
        <div class="tab-content active">
          ${row('Живое сохранение', 'Каждое изменение мгновенно попадает в localStorage, а затем в IndexedDB. Это защищает последнюю фразу при сбое питания.', toggle('liveSave'))}
          ${row('Интервал автосохранения', 'Как часто фоновый autosave подтверждает состояние документов в локальной базе.', range('autosaveMinutes', 1, 15, 1, ' мин'))}
          ${row('Снапшоты / Машина времени', 'Снапшоты теперь создаются только вручную кнопкой камеры или кнопкой ниже.', `${toggle('timeMachine')}<button class="pill-btn ai-btn" data-action="manual-snapshot"><i class="bx bx-camera"></i> Снапшот</button><button class="pill-btn" data-action="show-history">История</button>`)}
          ${row('Невидимое Git-версионирование', 'В веб-сборке работает как адаптер-состояние; в Tauri/Electron подключается simple-git.', toggle('gitVersioning'))}
          ${row('Сквозное шифрование', 'AES-GCM для содержимого документов перед записью в IndexedDB.', toggle('e2e'))}
          ${row('Мастер-пароль сессии', 'Используется для расшифровки в текущей сессии и не отправляется наружу.', `<input class="form-control" type="password" id="session-password" value="${escapeHtml(this.state.sessionPassword)}"><button class="pill-btn" data-action="save-password">Применить</button>`)}
          ${row('Сбросить настройки', 'Возвращает все настройки интерфейса, текста, ИИ и экспорта к базовым значениям. Документы не удаляются.', `<button class="pill-btn" data-action="reset-settings">Сбросить настройки</button>`)}
          <section class="misc-card" style="margin-top: 24px; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.02); padding: 18px 24px; border-radius: 8px;">
            <div class="misc-card-head" style="margin-bottom: 18px;">
              <div>
                <h3 style="color: #ef4444; font-weight: 600;">Очистка данных</h3>
                <p>Выборочное удаление элементов вашего проекта. Эти действия необратимы.</p>
              </div>
            </div>
            <div class="misc-action-grid">
              <button class="pill-btn danger-btn" data-action="clear-all-docs"><i class="bx bx-trash"></i> Удалить документы</button>
              <button class="pill-btn danger-btn" data-action="clear-all-characters"><i class="bx bx-user-x"></i> Удалить персонажей</button>
              <button class="pill-btn danger-btn" data-action="clear-all-locations"><i class="bx bx-map-alt"></i> Удалить локации</button>
              <button class="pill-btn danger-btn" data-action="clear-all-notes"><i class="bx bx-note"></i> Удалить записи</button>
              <button class="pill-btn danger-btn" data-action="clear-all-timeline"><i class="bx bx-git-commit"></i> Удалить таймлайн</button>
              <button class="pill-btn danger-btn" data-action="clear-all-kb"><i class="bx bx-book-content"></i> Очистить БЗ</button>
              <button class="pill-btn danger-btn" data-action="reset-data" style="grid-column: 1 / -1;"><i class="bx bx-reset"></i> Сбросить проект</button>
            </div>
          </section>
        </div>`,

      macros: this.macrosSettingsContent(),
      export: this.exportSettingsContent(row, toggle, input),
      search: this.searchSettingsContent(),
    };
    return content[tab] || content.visual;
  }

  getSettingsRegistry() {
    const presetFonts = [
      ['Lora', 'Lora (Serif)'],
      ['Georgia', 'Georgia (Classic)'],
      ['Manrope', 'Manrope (Sans)'],
      ['Inter', 'Inter (Modern)'],
      ['Playfair Display', 'Playfair Display (Elegant)'],
      ['Merriweather', 'Merriweather (Readability)'],
      ['Courier New', 'Courier New (Monospace)'],
    ];
    const customFonts = (this.state.settings.customFonts || []).map((f) => [f.name, f.name]);
    return [
      { tab: 'visual', label: 'Тема оформления', note: 'Меняет базовую палитру интерфейса без изменения структуры документов.', key: 'theme', type: 'select', options: [['nocturne', 'Nocturne Dark'], ['midnight', 'Deep Midnight'], ['paper', 'Paper Light'], ['matrix', 'Cyberpunk Matrix'], ['lavender', 'Lavender Bloom'], ['crimson', 'Crimson Flame']] },
      { tab: 'visual', label: 'Кастомный акцентный цвет', note: 'Обновляет кнопки, свечения и подсветку сущностей.', key: 'accent', type: 'accent' },
      { tab: 'visual', label: 'Прозрачность окна / Blur', note: 'В веб-версии включает CSS-материал; desktop bridge сможет подключить Mica/Vibrancy.', key: 'windowMaterial', type: 'toggle' },
      { tab: 'visual', label: 'Свечение курсора', note: 'Добавляет мягкую подсветку вокруг позиции ввода, чтобы легче держать фокус на строке.', key: 'cursorGlow', type: 'toggle' },
      { tab: 'visual', label: 'Стиль каретки', note: 'Выберите форму курсора ввода: тонкая линия, блок или нижнее подчёркивание.', key: 'caretStyle', type: 'select', options: [['line', 'Тонкая линия'], ['block', 'Блок'], ['underline', 'Подчеркивание']] },
      { tab: 'visual', label: 'Скорость мигания', note: 'Интервал мигания кастомной каретки в миллисекундах.', key: 'caretBlink', type: 'range', min: 250, max: 1400, step: 10, suffix: 'ms' },
      { tab: 'visual', label: 'Плавное дыхание каретки', note: 'Добавляет еле заметную анимацию каретки вместо резкого мигания.', key: 'caretBreath', type: 'toggle' },
      { tab: 'visual', label: 'Уровень контрастности текста', note: 'Поднимает или снижает яркость текста на странице, не меняя тему целиком.', key: 'textContrast', type: 'range', min: 45, max: 100, step: 1, suffix: '%' },
      { tab: 'visual', label: 'Компактный режим панелей', note: 'Сужает боковые панели и плотнее собирает служебный интерфейс.', key: 'compactPanels', type: 'toggle' },
      { tab: 'visual', label: 'Режим пишущей машинки', note: 'Держит активную строку вертикально по центру экрана — как в профессиональных редакторах.', key: 'typewriterMode', type: 'toggle' },
      { tab: 'editor', label: 'Шрифт рукописи', note: 'Меняет семейство шрифта только в рабочей рукописи, не в интерфейсе.', key: 'fontFamily', type: 'select', options: [...presetFonts, ...customFonts] },
      { tab: 'editor', label: 'Размер шрифта', note: 'Базовый размер текста на странице редактора.', key: 'fontSize', type: 'range', min: 14, max: 26, step: 1, suffix: 'px' },
      { tab: 'editor', label: 'Межстрочный интервал', note: 'Высота строки. Большие значения дают больше воздуха для вычитки.', key: 'lineHeight', type: 'range', min: 1.35, max: 2.25, step: 0.05 },
      { tab: 'editor', label: 'Межбуквенный интервал', note: 'Дополнительный трекинг между буквами для комфортного чтения.', key: 'letterSpacing', type: 'range', min: 0, max: 1.8, step: 0.1, suffix: 'px' },
      { tab: 'editor', label: 'Отступ между абзацами', note: 'Вертикальный интервал после абзаца в em относительно текущего шрифта.', key: 'paragraphSpacing', type: 'range', min: 0.25, max: 2.2, step: 0.05, suffix: 'em' },
      { tab: 'editor', label: 'Абзацный отступ', note: 'Добавляет красную строку в прозе вместо разделения только вертикальным отступом.', key: 'paragraphIndent', type: 'toggle' },
      { tab: 'editor', label: 'Умная пунктуация', note: 'Заменяет --, ..., прямые кавычки на типографские символы.', key: 'smartPunctuation', type: 'toggle' },
      { tab: 'editor', label: 'Подсветка синтаксиса писателя', note: 'Диалоги и мысли получают отдельный визуальный слой.', key: 'writerSyntax', type: 'toggle' },
      { tab: 'editor', label: 'Ритм чтения', note: 'Длинные предложения подсвечиваются красным, короткие зеленым.', key: 'readability', type: 'toggle' },
      { tab: 'editor', label: 'Проверка частых ошибок', note: 'Локальная точечная проверка распространённых опечаток и неправильных написаний.', key: 'strictSpellcheck', type: 'toggle' },
      { tab: 'editor', label: 'Типографская сетка', note: 'Показывает ритмическую направляющую строк для оценки вертикального набора.', key: 'baselineGrid', type: 'toggle' },
      { tab: 'focus', label: 'Показывать кнопку «Дзен» в верхней панели', note: 'Добавляет кнопку быстрого входа в режим концентрации.', key: 'showZenButton', type: 'toggle' },
      { tab: 'focus', label: 'Фокус на предложении / абзаце', note: 'Приглушает соседний текст и помогает вычитывать текущий фрагмент.', key: 'sentenceFocus', type: 'toggle' },
      { tab: 'focus', label: 'Пагинация MS Word (Экспериментально)', note: 'Разбивает ваш текст на страницы визуально, симулируя печатный лист.', key: 'autoPaginate', type: 'toggle' },
      { tab: 'focus', label: 'Линейки страниц', note: 'Показывает тонкие направляющие полей и рабочей области страницы.', key: 'showPageRulers', type: 'toggle' },
      { tab: 'focus', label: 'Звуки клавиш (Экспериментально)', note: 'Мягкий тихий щелчок синтезатора при наборе текста.', key: 'typewriterSound', type: 'toggle' },
      { tab: 'focus', label: 'Анимация письма', note: 'Искры, волна, туман или отключение анимации ввода.', key: 'writingAnimation', type: 'select', options: [['sparkles', 'Искры'], ['ripple', 'Волна'], ['mist', 'Туман'], ['off', 'Выключено']] },
      { tab: 'focus', label: 'Дневная цель слов', note: 'Количество слов, к которому стремится дневной прогресс в нижней части sidebar.', key: 'dailyGoal', type: 'range', min: 100, max: 10000, step: 100 },
      { tab: 'focus', label: 'Show, Don’t Tell анализатор', note: 'Локально подсвечивает слабые слова и места, где фразу можно показать действием.', key: 'showDontTell', type: 'toggle' },
      { tab: 'focus', label: 'Фокус-линза', note: 'Позволяет временно выделить диалоги или описания и приглушить остальной текст.', key: 'dialogueLens', type: 'select', options: [['off', 'Выключено'], ['dialogues', 'Только диалоги'], ['descriptions', 'Только описания']] },
      { tab: 'ai', label: 'LLM Provider', note: 'Режим «Не настроен» ничего не генерирует.', key: 'aiProvider', type: 'select', options: [['local', 'Не настроен / без генерации'], ['ollama', 'Ollama'], ['groq', 'Groq free tier'], ['gemini', 'Gemini free tier'], ['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic-compatible']] },
      { tab: 'ai', label: 'Endpoint', note: 'Адрес API выбранного провайдера.', key: 'aiEndpoint', type: 'input' },
      { tab: 'ai', label: 'API Key', note: 'Ключ хранится локально в настройках браузера.', key: 'aiKey', type: 'input', inputType: 'password' },
      { tab: 'ai', label: 'Model', note: 'Идентификатор модели, который понимает выбранный провайдер.', key: 'aiModel', type: 'input' },
      { tab: 'ai', label: 'Персона редактора', note: 'Стиль поведения AI ассистента.', key: 'aiPersona', type: 'select', options: [['critic', 'Злой критик'], ['muse', 'Муза'], ['coauthor', 'Соавтор']] },
      { tab: 'ai', label: 'Креативность', note: 'Температура запроса: ниже — предсказуемее, выше — свободнее.', key: 'aiTemperature', type: 'range', min: 0, max: 1.4, step: 0.05 },
      { tab: 'ai', label: 'Контекст базы знаний', note: 'Передаёт ассистенту релевантных персонажей, локации, таймлайн и т.д.', key: 'aiKnowledgeContext', type: 'toggle' },
      { tab: 'ai', label: 'Строгость хранителя лора', note: 'Насколько жёстко локальная проверка реагирует на противоречия с Базой знаний.', key: 'loreStrictness', type: 'range', min: 0, max: 100, step: 1, suffix: '%' },
      { tab: 'ai', label: 'Реакция на конфликт лора', note: 'Действие при обнаружении нестыковок с Базой Знаний.', key: 'loreReaction', type: 'select', options: [['soft', 'Подсказать'], ['warn', 'Предупредить'], ['hard', 'Блокировать сохранение абзаца']] },
      { tab: 'ai', label: 'Sentiment Timeline', note: 'Показывает локальную кривую эмоциональной напряжённости.', key: 'sentimentTimeline', type: 'toggle' },
      { tab: 'data', label: 'Живое сохранение', note: 'Каждое изменение мгновенно попадает в localStorage, а затем в IndexedDB.', key: 'liveSave', type: 'toggle' },
      { tab: 'data', label: 'Интервал автосохранения', note: 'Как часто фоновый autosave подтверждает состояние документов.', key: 'autosaveMinutes', type: 'range', min: 1, max: 15, step: 1, suffix: ' мин' },
      { tab: 'data', label: 'Снапшоты / Машина времени', note: 'Снапшоты теперь создаются только вручную.', key: 'timeMachine', type: 'toggle' },
      { tab: 'data', label: 'Невидимое Git-версионирование', note: 'Автоматическое сохранение в локальный git-репозиторий.', key: 'gitVersioning', type: 'toggle' },
      { tab: 'data', label: 'Сквозное шифрование', note: 'AES-GCM для содержимого документов перед записью.', key: 'e2e', type: 'toggle' },
      { tab: 'export', label: 'Водяной знак PDF', note: 'Добавляет полупрозрачную подпись автора и дату в печатный PDF-макет.', key: 'watermark', type: 'toggle' },
      { tab: 'export', label: 'Имя автора', note: 'Попадает в метаданные DOCX и используется в водяном знаке PDF.', key: 'authorName', type: 'input' },
      { tab: 'review', label: 'Экспортировать .nocturned рядом с DOCX', note: 'Если у документа есть редакторские правок, рядом с DOCX скачивается JSON-файл обмена правками.', key: 'exportNocturned', type: 'toggle' },
      { tab: 'misc', label: 'Экспериментальный дизайн', note: 'Включает ультра-хайповый детализированный UI.', key: 'experimentalDesign', type: 'toggle' },
    ];
  }

  scoreSetting(setting, query) {
    const title = setting.label.toLowerCase();
    const note = (setting.note || '').toLowerCase();
    if (title === query) return 1000;
    if (title.startsWith(query)) return 800 - title.indexOf(query);
    if (title.includes(query)) return 500 - title.indexOf(query);
    if (note.includes(query)) return 100 - note.indexOf(query);
    return 0;
  }

  scoreSettingSection(tab, query) {
    const label = tab.label.toLowerCase();
    const note = tab.note.toLowerCase();
    const id = tab.id.toLowerCase();
    if (label === query || id === query) return 1000;
    if (label.startsWith(query) || id.startsWith(query)) return 850 - label.indexOf(query);
    if (label.includes(query) || id.includes(query)) return 600 - label.indexOf(query);
    if (note.includes(query)) return 150 - note.indexOf(query);
    return 0;
  }

  searchSettingsContent() {
    const query = String(this.state.settingsSearchQuery || '').trim().toLowerCase();
    let resultsHtml = '';
    if (!query) {
      resultsHtml = `
        <div class="settings-search-empty">
          <i class="bx bx-search-alt"></i>
          <p>Введите поисковый запрос, чтобы найти нужную настройку...</p>
        </div>
      `;
    } else {
      const tabsList = [
        { id: 'visual', label: 'Внешний вид и Оформление', note: 'Цветовая тема, акцентный цвет темы, стиль каретки, компактность, typewriter.' },
        { id: 'editor', label: 'Настройки рукописи и Шрифты', note: 'Размер, отступы, шрифты рукописи, умная пунктуация, строгость проверки.' },
        { id: 'focus', label: 'Концентрация и Фокус', note: 'Режим дзен, фокус на абзаце, пагинация MS Word, звуки клавиш, анимация.' },
        { id: 'dictionary', label: 'Словарь автозамены', note: 'Настройка автоматического исправления опечаток и правил spellcheck.' },
        { id: 'review', label: 'Режимы работы и Редактура', note: 'Режим письма, редактора или финализации, экспорт правок.' },
        { id: 'macros', label: 'Клавиатурные макросы', note: 'Настройка клавиатурных макросов и автозамены.' },
        { id: 'ai', label: 'AI Ассистент', note: 'Провайдеры искусственного интеллекта, ключи, температура, контекст базы знаний.' },
        { id: 'data', label: 'Данные и Резервное копирование', note: 'Интервалы автосохранения, Git-версионирование, сквозное шифрование, удаление данных.' },
        { id: 'export', label: 'Параметры экспорта', note: 'Водяной знак PDF, имя автора.' },
        { id: 'misc', label: 'Прочее', note: 'Экспериментальный дизайн, очистка, сброс настроек.' }
      ];
      const scoredSections = tabsList
        .map((tab) => ({ tab, score: this.scoreSettingSection(tab, query) }))
        .filter((res) => res.score > 0)
        .sort((a, b) => b.score - a.score);

      const registry = this.getSettingsRegistry();
      const scored = registry
        .map((item) => {
          const score = this.scoreSetting(item, query);
          return { item, score };
        })
        .filter((res) => res.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0 && scoredSections.length === 0) {
        resultsHtml = `
          <div class="settings-search-empty">
            <i class="bx bx-search-alt"></i>
            <p>Ничего не найдено по запросу «${escapeHtml(this.state.settingsSearchQuery)}»</p>
          </div>
        `;
      } else {
        const s = this.state.settings;
        const row = (label, note, control) => `<div class="setting-row"><div class="setting-info"><span>${label}${note ? `<i class="bx bx-info-circle info-icon" tabindex="0" data-tip="${escapeHtml(note)}"></i>` : ''}</span>${note ? `<small>${note}</small>` : ''}</div><div class="setting-control">${control}</div></div>`;
        const toggle = (key) => `<div class="toggle ${s[key] ? 'on' : ''}" data-setting="${key}" data-kind="toggle"></div>`;
        const range = (key, min, max, step = 1, suffix = '') => `<div class="range-field" data-range-field><input class="range-control" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-setting="${key}" data-suffix="${escapeHtml(suffix)}"><span class="range-value">${s[key]}${suffix}</span></div>`;
        const select = (key, options) => this.renderSettingsSelect(key, options);
        const input = (key, type = 'text') => `<input class="form-control" type="${type}" value="${escapeHtml(s[key] || '')}" data-setting="${key}">`;
        
        let sectionsHtml = scoredSections.map(({ tab }) => `
          <div class="setting-row tab-link-row" style="background: rgba(var(--accent-rgb, 139, 92, 246), 0.04); border-left: 3px solid var(--accent); padding: 12px; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div class="setting-info" style="display: flex; flex-direction: column; gap: 4px;">
              <span style="font-weight: 600; color: var(--text-color);">Раздел: ${escapeHtml(tab.label)}</span>
              <small style="color: var(--text-muted); font-size: 12px;">${escapeHtml(tab.note)}</small>
            </div>
            <div class="setting-control">
              <button class="pill-btn" data-settings-tab="${tab.id}"><i class="bx bx-chevron-right"></i> Перейти</button>
            </div>
          </div>
        `).join('');

        let itemsHtml = scored.map(({ item }) => {
          let control = '';
          if (item.type === 'toggle') {
            control = toggle(item.key);
          } else if (item.type === 'range') {
            control = range(item.key, item.min, item.max, item.step, item.suffix || '');
          } else if (item.type === 'select') {
            control = select(item.key, item.options);
          } else if (item.type === 'input') {
            control = input(item.key, item.inputType || 'text');
          } else if (item.type === 'accent') {
            control = this.renderAccentColorControl();
          }
          return row(item.label, item.note, control);
        }).join('');

        resultsHtml = itemsHtml + sectionsHtml;
      }
    }
    return `
      <div class="tab-content active settings-search-tab">
        <div class="settings-search-container">
          <div class="settings-search-input-wrap">
            <i class="bx bx-search"></i>
            <input type="text" id="settings-search-field" class="form-control settings-search-input" placeholder="Поиск по названию или описанию настройки..." value="${escapeHtml(this.state.settingsSearchQuery || '')}" autocomplete="off">
          </div>
        </div>
        <div class="settings-search-results-list">
          ${resultsHtml}
        </div>
      </div>
    `;
  }

  updateSettingsSearchList() {
    const listEl = document.querySelector('.settings-search-results-list');
    if (!listEl) return;
    const query = String(this.state.settingsSearchQuery || '').trim().toLowerCase();
    let resultsHtml = '';
    if (!query) {
      resultsHtml = `
        <div class="settings-search-empty">
          <i class="bx bx-search-alt"></i>
          <p>Введите поисковый запрос, чтобы найти нужную настройку...</p>
        </div>
      `;
    } else {
      const tabsList = [
        { id: 'visual', label: 'Внешний вид и Оформление', note: 'Цветовая тема, акцентный цвет темы, стиль каретки, компактность, typewriter.' },
        { id: 'editor', label: 'Настройки рукописи и Шрифты', note: 'Размер, отступы, шрифты рукописи, умная пунктуация, строгость проверки.' },
        { id: 'focus', label: 'Концентрация и Фокус', note: 'Режим дзен, фокус на абзаце, пагинация MS Word, звуки клавиш, анимация.' },
        { id: 'dictionary', label: 'Словарь автозамены', note: 'Настройка автоматического исправления опечаток и правил spellcheck.' },
        { id: 'review', label: 'Режимы работы и Редактура', note: 'Режим письма, редактора или финализации, экспорт правок.' },
        { id: 'macros', label: 'Клавиатурные макросы', note: 'Настройка клавиатурных макросов и автозамены.' },
        { id: 'ai', label: 'AI Ассистент', note: 'Провайдеры искусственного интеллекта, ключи, температура, контекст базы знаний.' },
        { id: 'data', label: 'Данные и Резервное копирование', note: 'Интервалы автосохранения, Git-версионирование, сквозное шифрование, удаление данных.' },
        { id: 'export', label: 'Параметры экспорта', note: 'Водяной знак PDF, имя автора.' },
        { id: 'misc', label: 'Прочее', note: 'Экспериментальный дизайн, очистка, сброс настроек.' }
      ];
      const scoredSections = tabsList
        .map((tab) => ({ tab, score: this.scoreSettingSection(tab, query) }))
        .filter((res) => res.score > 0)
        .sort((a, b) => b.score - a.score);

      const registry = this.getSettingsRegistry();
      const scored = registry
        .map((item) => {
          const score = this.scoreSetting(item, query);
          return { item, score };
        })
        .filter((res) => res.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length === 0 && scoredSections.length === 0) {
        resultsHtml = `
          <div class="settings-search-empty">
            <i class="bx bx-search-alt"></i>
            <p>Ничего не найдено по запросу «${escapeHtml(this.state.settingsSearchQuery)}»</p>
          </div>
        `;
      } else {
        const s = this.state.settings;
        const row = (label, note, control) => `<div class="setting-row"><div class="setting-info"><span>${label}${note ? `<i class="bx bx-info-circle info-icon" tabindex="0" data-tip="${escapeHtml(note)}"></i>` : ''}</span>${note ? `<small>${note}</small>` : ''}</div><div class="setting-control">${control}</div></div>`;
        const toggle = (key) => `<div class="toggle ${s[key] ? 'on' : ''}" data-setting="${key}" data-kind="toggle"></div>`;
        const range = (key, min, max, step = 1, suffix = '') => `<div class="range-field" data-range-field><input class="range-control" type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}" data-setting="${key}" data-suffix="${escapeHtml(suffix)}"><span class="range-value">${s[key]}${suffix}</span></div>`;
        const select = (key, options) => this.renderSettingsSelect(key, options);
        const input = (key, type = 'text') => `<input class="form-control" type="${type}" value="${escapeHtml(s[key] || '')}" data-setting="${key}">`;
        
        let sectionsHtml = scoredSections.map(({ tab }) => `
          <div class="setting-row tab-link-row" style="background: rgba(var(--accent-rgb, 139, 92, 246), 0.04); border-left: 3px solid var(--accent); padding: 12px; border-radius: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <div class="setting-info" style="display: flex; flex-direction: column; gap: 4px;">
              <span style="font-weight: 600; color: var(--text-color);">Раздел: ${escapeHtml(tab.label)}</span>
              <small style="color: var(--text-muted); font-size: 12px;">${escapeHtml(tab.note)}</small>
            </div>
            <div class="setting-control">
              <button class="pill-btn" data-settings-tab="${tab.id}"><i class="bx bx-chevron-right"></i> Перейти</button>
            </div>
          </div>
        `).join('');

        let itemsHtml = scored.map(({ item }) => {
          let control = '';
          if (item.type === 'toggle') {
            control = toggle(item.key);
          } else if (item.type === 'range') {
            control = range(item.key, item.min, item.max, item.step, item.suffix || '');
          } else if (item.type === 'select') {
            control = select(item.key, item.options);
          } else if (item.type === 'input') {
            control = input(item.key, item.inputType || 'text');
          } else if (item.type === 'accent') {
            control = this.renderAccentColorControl();
          }
          return row(item.label, item.note, control);
        }).join('');

        resultsHtml = itemsHtml + sectionsHtml;
      }
    }
    listEl.innerHTML = resultsHtml;
    this.updateRangeControls(listEl);
    this.updateAccentPickerControls(listEl);
  }

  exportSettingsContent(row, toggle, input) {
    return `
      <div class="tab-content active export-settings">
        <section class="export-hero-card">
          <div>
            <span class="export-kicker">Экспорт</span>
            <h3>Профессиональный экспорт</h3>
            <p>Соберите рукопись для чтения, печати или обмена с редактором.</p>
          </div>
          <div class="export-badges"><span>PDF</span><span>DOCX</span><span>.NOCTURNED</span></div>
        </section>
        <section class="export-format-grid">
          <article class="export-format-card">
            <i class="bx bxs-file-pdf"></i>
            <h4>PDF для чтения и печати</h4>
            <p>Открывает печатный макет с пагинацией, полями и опциональным водяным знаком.</p>
            <div class="export-card-action"><button class="pill-btn ai-btn" data-action="export-html"><i class="bx bx-export"></i> Экспортировать PDF</button></div>
          </article>
          <article class="export-format-card">
            <i class="bx bxs-file-doc"></i>
            <h4>DOCX для редактора</h4>
            <p>Генерирует Word-совместимый документ с заголовками, абзацами, заметками и метаданными.</p>
            <div class="export-card-action"><button class="pill-btn ai-btn" data-action="export-docx"><i class="bx bx-file-export"></i> Экспортировать DOCX</button></div>
          </article>
          <article class="export-format-card review-package">
            <i class="bx bx-git-pull-request"></i>
            <h4>Пакет правок .nocturned</h4>
            <p>Если у документа есть reviewMarks, рядом с DOCX можно скачать JSON-файл обмена правками.</p>
            <div class="export-card-action"><div class="inline-export-toggle"><span>Скачивать рядом с DOCX</span><div class="toggle ${this.state.exportNocturned ? 'on' : ''}" data-action="toggle-nocturned-export"></div></div></div>
          </article>
          <article class="export-format-card project-dump-card">
            <i class="bx bx-archive"></i>
            <h4>Резервная копия проекта .nocturnedump</h4>
            <p>Один файл со всеми главами, базой знаний, заметками, правками, словарём и настройками.</p>
            <div class="export-card-action">
              <button class="pill-btn ai-btn" data-action="export-project-dump"><i class="bx bx-archive-out"></i> Экспорт проекта</button>
              <button class="pill-btn" data-action="import-project-dump"><i class="bx bx-archive-in"></i> Импорт проекта</button>
            </div>
          </article>
        </section>
        <section class="export-meta-card">
          <div class="setting-group-title">Метаданные</div>
          ${row('Имя автора', 'Попадает в метаданные DOCX и используется в водяном знаке PDF.', input('authorName'))}
          ${row('Водяной знак PDF', 'Добавляет полупрозрачную подпись автора и дату в печатный PDF-макет.', toggle('watermark'))}
        </section>
      </div>`;
  }

  macrosSettingsContent() {
    const s = this.state.settings;
    const macros = s.macros || [];
    const recordBtnText = this.macroRecordingState ? 'Запись...' : 'Записать';
    const recordedVal = this.macroRecordedKeys || '';
    
    return `
      <div class="tab-content active macros-settings">
        <section class="macros-hero">
          <div>
            <h3>Клавиатурные Макросы</h3>
            <p>Настройте автозамену при печати. Например, одновременное нажатие <strong>Ctrl + [</strong> выдаст <strong>«</strong>, или любая другая комбинация клавиш вставит нужный символ.</p>
          </div>
        </section>

        <section class="macro-add-card">
          <h4>Добавить новый макрос</h4>
          <div class="macro-form-grid">
            <div class="macro-form-field">
              <label>Сочетание клавиш</label>
              <div class="macro-record-wrapper">
                <input class="form-control" type="text" id="new-macro-keys" placeholder="Нажмите 'Записать'..." value="${escapeHtml(recordedVal)}" readonly>
                <button class="pill-btn ${this.macroRecordingState ? 'recording active' : ''}" data-action="macro-record-toggle">${recordBtnText}</button>
              </div>
              <div id="macro-conflict-warning" class="macro-warning" style="display:none; color:var(--accent); font-size:12px; margin-top:6px; font-weight:500;"></div>
            </div>
            <div class="macro-form-field">
              <label>Выводимый символ</label>
              <input class="form-control" type="text" id="new-macro-value" placeholder="Например, « или —" maxlength="50">
            </div>
            <div class="macro-form-field btn-field">
              <button class="pill-btn ai-btn" data-action="macro-save-new"><i class="bx bx-plus"></i> Добавить</button>
            </div>
          </div>
        </section>

        <section class="macros-list-section">
          <h4>Список макросов (${macros.length})</h4>
          <div class="macros-list">
            ${macros.length === 0 ? `
              <div class="macros-empty-state">
                <i class="bx bx-keyboard"></i>
                <p>У вас пока нет макросов. Запишите первый макрос выше!</p>
              </div>
            ` : macros.map((macro, idx) => `
              <div class="macro-item">
                <div class="macro-keys-badge">${escapeHtml(macro.keys)}</div>
                <div class="macro-arrow"><i class="bx bx-right-arrow-alt"></i></div>
                <div class="macro-value-badge">${escapeHtml(macro.value)}</div>
                <button class="btn-icon delete-btn" data-action="macro-delete" data-macro-idx="${idx}" title="Удалить"><i class="bx bx-trash"></i></button>
              </div>
            `).join('')}
          </div>
        </section>
      </div>
    `;
  }

  renderMacrosListOnly() {
    // Update only the macros list section without triggering a full settings re-render
    const s = this.state.settings;
    const macros = s.macros || [];

    // Update record button state
    const recordBtn = document.querySelector('[data-action="macro-record-toggle"]');
    if (recordBtn) {
      const btnText = this.macroRecordingState ? 'Запись... (нажмите клавиши)' : 'Записать';
      recordBtn.textContent = btnText;
      recordBtn.classList.toggle('recording', !!this.macroRecordingState);
      recordBtn.classList.toggle('active', !!this.macroRecordingState);
    }
    const keysInput = document.getElementById('new-macro-keys');
    if (keysInput) keysInput.value = this.macroRecordedKeys || '';

    // Update the macros list
    const listEl = document.querySelector('.macros-list');
    if (!listEl) { this.renderSettings(); return; }
    const countEl = document.querySelector('.macros-list-section h4');
    if (countEl) countEl.textContent = `Список макросов (${macros.length})`;
    listEl.innerHTML = macros.length === 0
      ? `<div class="macros-empty-state"><i class="bx bx-keyboard"></i><p>У вас пока нет макросов. Запишите первый макрос выше!</p></div>`
      : macros.map((macro, idx) => `
          <div class="macro-item">
            <div class="macro-keys-badge">${escapeHtml(macro.keys)}</div>
            <div class="macro-arrow"><i class="bx bx-right-arrow-alt"></i></div>
            <div class="macro-value-badge">${escapeHtml(macro.value)}</div>
            <button class="btn-icon delete-btn" data-action="macro-delete" data-macro-idx="${idx}" title="Удалить"><i class="bx bx-trash"></i></button>
          </div>`).join('');
  }

  aiProviderPresets() {
    return {
      gemini: {
        label: 'Gemini API',
        subtitle: 'через OpenAI-compatible endpoint',
        helper: 'Вставьте ключ Gemini API. Доступность бесплатных моделей и лимиты зависят от Google.',
        provider: 'openai',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        model: 'gemini-2.5-flash',
      },
      groq: {
        label: 'Groq',
        subtitle: 'OpenAI-compatible API',
        helper: 'Быстрый провайдер, лимиты и доступность моделей могут меняться.',
        provider: 'groq',
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        model: 'llama-3.3-70b-versatile',
      },
      openrouter: {
        label: 'OpenRouter Free',
        subtitle: 'маршрутизация на free-модели',
        helper: 'Маршрутизирует запросы на бесплатные модели. Качество и доступные модели могут меняться.',
        provider: 'openai',
        endpoint: 'https://openrouter.ai/api/v1/chat/completions',
        model: 'openrouter/free',
      },
      mistral: {
        label: 'Mistral',
        subtitle: 'экспериментальный API-тариф',
        helper: 'Бесплатный экспериментальный тариф предназначен для тестов и прототипов; лимиты ограничены.',
        provider: 'openai',
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
        model: 'mistral-small-latest',
      },
    };
  }

  aiPresetsContent() {
    const presets = this.aiProviderPresets();
    return `
      <section class="ai-preset-section">
        <div class="ai-preset-head">
          <div>
            <h3>Быстрые пресеты</h3>
            <p>Автозаполнение endpoint и model. Поля остаются редактируемыми вручную.</p>
          </div>
        </div>
        <div class="ai-preset-grid">
          ${Object.entries(presets).map(([id, preset]) => `
            <article class="ai-preset-card">
              <div>
                <strong>${escapeHtml(preset.label)}</strong>
                <span>${escapeHtml(preset.subtitle)}</span>
                <small>${escapeHtml(preset.helper)}</small>
              </div>
              <button class="pill-btn" data-action="apply-ai-preset" data-ai-preset="${escapeHtml(id)}">Применить</button>
            </article>
          `).join('')}
        </div>
        <p class="ai-preset-note">Бесплатные тарифы, модели и лимиты задаются провайдерами и могут меняться.</p>
      </section>`;
  }

  async applyAiPreset(id) {
    const preset = this.aiProviderPresets()[id];
    if (!preset) return;
    Object.assign(this.state.settings, {
      aiProvider: preset.provider,
      aiEndpoint: preset.endpoint,
      aiModel: preset.model,
      aiKey: '',
    });
    await this.persistSettings();
    this.renderSettings();
    requestAnimationFrame(() => {
      const keyInput = document.querySelector('[data-setting="aiKey"]');
      keyInput?.focus();
      keyInput?.classList.add('input-attention');
      setTimeout(() => keyInput?.classList.remove('input-attention'), 900);
    });
    this.toast(`Пресет ${preset.label} применён. Вставьте API-ключ.`);
  }

  async testAiConnection() {
    const problem = this.assistantProviderProblem();
    if (problem) {
      this.toast(problem);
      return;
    }
    const previous = this.assistantPanelMessage;
    try {
      let result = '';
      await this.streamAi('Ответь одним словом: OK', (chunk) => { result += chunk; });
      this.setAssistantOutput(previous || 'Готов к работе.');
      this.toast(result.trim() ? 'Подключение работает.' : 'Провайдер ответил пустым сообщением.');
    } catch (error) {
      this.toast(error.message || 'Не удалось проверить подключение.');
    }
  }

  handleSettingsTooltipEnter(event) {
    const icon = event.target.closest?.('.info-icon[data-tip]');
    if (!icon) return;
    clearTimeout(this.settingsTooltipHideTimer);
    this.settingsTooltipTimer = setTimeout(() => this.showSettingsTooltip(icon), 140);
  }

  handleSettingsTooltipLeave(event) {
    const icon = event.target.closest?.('.info-icon[data-tip]');
    if (!icon) return;
    clearTimeout(this.settingsTooltipTimer);
    this.settingsTooltipHideTimer = setTimeout(() => this.hideSettingsTooltip(), 220);
  }

  showSettingsTooltip(icon) {
    const tooltip = document.getElementById('settings-help-tooltip');
    if (!tooltip || !icon?.isConnected) return;
    tooltip.textContent = icon.dataset.tip || '';
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.classList.add('active');
    const iconRect = icon.getBoundingClientRect();
    const modalRect = document.querySelector('.settings-modal')?.getBoundingClientRect() || { left: 10, right: window.innerWidth - 10, top: 10, bottom: window.innerHeight - 10 };
    const width = Math.min(320, Math.max(240, modalRect.right - modalRect.left - 24));
    tooltip.style.width = `${width}px`;
    const tipRect = tooltip.getBoundingClientRect();
    let left = iconRect.left + iconRect.width / 2 - tipRect.width / 2;
    left = Math.max(modalRect.left + 12, Math.min(left, modalRect.right - tipRect.width - 12));
    let top = iconRect.top - tipRect.height - 12;
    if (top < modalRect.top + 12) top = iconRect.bottom + 12;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  hideSettingsTooltip(immediate = false) {
    const tooltip = document.getElementById('settings-help-tooltip');
    clearTimeout(this.settingsTooltipTimer);
    clearTimeout(this.settingsTooltipHideTimer);
    if (!tooltip) return;
    const hide = () => {
      tooltip.classList.remove('active');
      tooltip.setAttribute('aria-hidden', 'true');
    };
    if (immediate) hide();
    else this.settingsTooltipHideTimer = setTimeout(hide, 80);
  }

  renderSettingsSelect(key, options) {
    const current = String(this.state.settings[key] ?? '');
    const selected = options.find(([value]) => String(value) === current) || options[0] || ['', ''];
    return `
      <div class="nocturne-select" data-setting-select="${escapeHtml(key)}">
        <button type="button" class="nocturne-select-trigger" data-setting-select-toggle aria-haspopup="listbox" aria-expanded="false">
          <span>${escapeHtml(selected[1])}</span>
          <i class="bx bx-chevron-down"></i>
        </button>
        <div class="nocturne-select-menu popover-surface" role="listbox" aria-hidden="true">
          ${options.map(([value, label]) => `
            <button type="button" class="nocturne-select-option ${String(value) === current ? 'selected' : ''}" role="option" aria-selected="${String(value) === current ? 'true' : 'false'}" data-setting-option="${escapeHtml(key)}" data-value="${escapeHtml(value)}">
              <span>${escapeHtml(label)}</span>
              <i class="bx bx-check"></i>
            </button>
          `).join('')}
        </div>
      </div>`;
  }

  closeSettingsSelects(except = null) {
    document.querySelectorAll('.nocturne-select.open').forEach((select) => {
      if (except && select === except) return;
      select.classList.remove('open');
      select.querySelector('[data-setting-select-toggle]')?.setAttribute('aria-expanded', 'false');
      select.querySelector('.nocturne-select-menu')?.setAttribute('aria-hidden', 'true');
    });
  }

  toggleSettingsSelect(select) {
    if (!select) return;
    const willOpen = !select.classList.contains('open');
    this.closeSettingsSelects(select);
    select.classList.toggle('open', willOpen);
    select.querySelector('[data-setting-select-toggle]')?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    select.querySelector('.nocturne-select-menu')?.setAttribute('aria-hidden', willOpen ? 'false' : 'true');
  }

  updateSettingFromCustomOption(option) {
    const key = option.dataset.settingOption;
    if (!key) return;
    this.state.settings[key] = option.dataset.value || '';
    this.state.settings = this.validateSettings(this.state.settings);
    this.closeSettingsSelects();
    this.applySettingSideEffects(key);
    if (key !== 'aiProvider') this.syncSettingsSelectControl(key);
  }

  syncSettingsSelectControl(key) {
    const current = String(this.state.settings[key] ?? '');
    document.querySelectorAll('.nocturne-select[data-setting-select]').forEach((select) => {
      if (select.dataset.settingSelect !== key) return;
      const options = Array.from(select.querySelectorAll('[data-setting-option]'));
      const selected = options.find((option) => String(option.dataset.value) === current) || options[0];
      select.querySelector('.nocturne-select-trigger span').textContent = selected?.querySelector('span')?.textContent || '';
      options.forEach((option) => {
        const active = option === selected;
        option.classList.toggle('selected', active);
        option.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    });
  }

  updateSettingFromControl(control) {
    const key = control.dataset.setting;
    if (!key) return;
    if (control.dataset.kind === 'toggle') {
      this.state.settings[key] = !this.state.settings[key];
      control.classList.toggle('on', this.state.settings[key]);
      control.classList.toggle('active', this.state.settings[key]);
    } else if (control.type === 'checkbox') {
      this.state.settings[key] = !!control.checked;
    } else if (control.type === 'range') {
      this.state.settings[key] = Number(control.value);
      this.updateRangeControl(control);
    } else {
      this.state.settings[key] = control.value;
    }
    this.state.settings = this.validateSettings(this.state.settings);
    this.applySettingSideEffects(key, control);
  }

  applySettingSideEffects(key, control = null) {
    if (key === 'writingAnimation') safeSetStorageItem(localStorage, 'nocturne-writing-animation-choice', '1');
    if (key === 'e2e') {
      if (this.state.settings.e2e) {
        safeRemoveStorageItem(localStorage, 'nocturne-global-notes');
        if (!this.state.sessionPassword) {
          this.promptForMasterPassword();
        }
      } else {
        this.disableE2eAndDecryptAll();
      }
    }
    if (key === 'aiProvider') this.applyProviderPreset();
    if (key === 'gitVersioning' || key === 'autosaveMinutes') this.startGitAutosave();
    this.applySettings();
    this.persistSettings();
    if (['fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing'].includes(key)) this.repaginateSettingsDebounced();
    if (key === 'readability') {
      this.updateReadabilityHighlights();
    }
    if (['strictSpellcheck', 'smartDictionary'].includes(key)) {
      this.disableBrowserSpellcheck();
      this.updateTypoHighlights();
    }
    if (['writerSyntax', 'showDontTell', 'dialogueLens'].includes(key)) this.renderWorkspace();
    if (key === 'autoPaginate') this.repaginateSettingsDebounced();
    if (key === 'showZenButton' && !this.state.settings.showZenButton && this.state.zenActive) this.toggleZen(false, { persist: false });
  }

  updateRangeControls(root = document) {
    root.querySelectorAll?.('.range-control').forEach((control) => this.updateRangeControl(control));
  }

  updateRangeControl(control) {
    const min = Number(control.min || 0);
    const max = Number(control.max || 100);
    const value = Number(control.value || 0);
    const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
    control.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, pct))}%`);
    const chip = control.closest('[data-range-field]')?.querySelector('.range-value') || control.nextElementSibling;
    if (chip) chip.textContent = `${control.value}${control.dataset.suffix || ''}`;
  }

  applyProviderPreset() {
    const s = this.state.settings;
    const presets = {
      local: { aiEndpoint: '', aiModel: '' },
      ollama: { aiEndpoint: 'http://localhost:11434/api/generate', aiModel: 'llama3.1' },
      groq: { aiEndpoint: 'https://api.groq.com/openai/v1/chat/completions', aiModel: 'llama-3.1-8b-instant' },
      gemini: { aiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent', aiModel: 'gemini-2.0-flash' },
      openai: { aiEndpoint: 'https://api.openai.com/v1/chat/completions', aiModel: 'gpt-4o-mini' },
      anthropic: { aiEndpoint: 'https://api.anthropic.com/v1/messages', aiModel: 'claude-3-5-haiku-latest' },
    };
    Object.assign(s, presets[s.aiProvider] || {});
    this.renderSettings();
    this.updateAssistantPanelState();
  }

    checkMacroConflict(keysStr) {
    if (!keysStr) return null;
    const normalize = (str) => {
      return str.split('+')
        .map((s) => s.trim().toUpperCase())
        .map((s) => s === 'CONTROL' ? 'CTRL' : s === 'OPTION' || s === 'COMMAND' ? 'META' : s)
        .sort()
        .join('+');
    };
    
    const targetNormalized = normalize(keysStr);
    
    const appShortcuts = {
      'CTRL+B': 'Жирный текст (Ctrl + B)',
      'CTRL+I': 'Курсивный текст (Ctrl + I)',
      'CTRL+S': 'Сохранение (Ctrl + S)',
      'CTRL+F': 'Поиск (Ctrl + F)',
      'CTRL+SHIFT+F': 'Глобальный поиск (Ctrl + Shift + F)',
      'CTRL+H': 'Замена (Ctrl + H)',
      'CTRL+K': 'Командная палитра (Ctrl + K)',
      '?': 'Горячие клавиши (?)',
      'ESCAPE': 'Закрыть окна (Escape)',
    };
    
    if (appShortcuts[targetNormalized]) {
      return `Конфликт с горячей клавишей Ноктюрна: "${appShortcuts[targetNormalized]}"`;
    }
    
    const macros = this.state.settings.macros || [];
    const conflictIdx = macros.findIndex(m => normalize(m.keys) === targetNormalized);
    if (conflictIdx !== -1) {
      return `Уже привязано к макросу: "${macros[conflictIdx].value}"`;
    }
    
    return null;
  }

  injectCustomFonts() {
    let styleEl = document.getElementById('nocturne-custom-fonts-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'nocturne-custom-fonts-style';
      document.head.appendChild(styleEl);
    }
    const fonts = this.state.settings.customFonts || [];
    let css = '';
    fonts.forEach(font => {
      css += `
        @font-face {
          font-family: ${JSON.stringify(font.name)};
          src: url(${JSON.stringify(font.data)});
          font-display: swap;
        }
      `;
    });
    styleEl.textContent = css;
  }

  applySettings() {
    const s = this.state.settings;
    const root = document.documentElement;
    const rgb = hexToRgb(s.accent);
    root.style.setProperty('--accent', s.accent);
    root.style.setProperty('--accent-hover', `rgb(${Math.min(255, rgb.r + 28)}, ${Math.min(255, rgb.g + 28)}, ${Math.min(255, rgb.b + 28)})`);
    root.style.setProperty('--accent-hover-rgb', `${Math.min(255, rgb.r + 28)}, ${Math.min(255, rgb.g + 28)}, ${Math.min(255, rgb.b + 28)}`);
    root.style.setProperty('--accent-glow', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, .25)`);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
        let resolvedFont = s.fontFamily || 'Lora';
    if (resolvedFont === 'Manrope') resolvedFont = "'Manrope', sans-serif";
    else if (resolvedFont === 'Georgia') resolvedFont = "Georgia, serif";
    else if (resolvedFont === 'Lora') resolvedFont = "'Lora', serif";
    else if (resolvedFont === 'Courier New') resolvedFont = "'Courier New', monospace";
    else resolvedFont = `'${resolvedFont}', serif`;
    root.style.setProperty('--font-editor', resolvedFont);
    root.style.setProperty('--font-size-editor', `${s.fontSize}px`);
    root.style.setProperty('--line-height-editor', s.lineHeight);
    root.style.setProperty('--letter-spacing-editor', `${s.letterSpacing}px`);
    root.style.setProperty('--paragraph-spacing', `${s.paragraphSpacing}em`);
    root.style.setProperty('--caret-speed', `${s.caretBlink}ms`);
    const contrast = s.theme === 'paper'
      ? Math.round(72 - (s.textContrast / 100) * 52)
      : Math.round(145 + (s.textContrast / 100) * 110);
    root.style.setProperty('--text-paper', s.theme === 'paper'
      ? `rgb(${Math.max(18, contrast)}, ${Math.max(16, contrast - 4)}, ${Math.max(14, contrast - 8)})`
      : `rgb(${contrast}, ${contrast}, ${Math.min(255, contrast + 8)})`);
    this.disableBrowserSpellcheck();
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    shell.classList.toggle('material', s.windowMaterial);
    document.body.classList.toggle('material', s.windowMaterial);
    shell.classList.toggle('zen', !!this.state.zenActive);
    document.body.classList.toggle('zen-mode', !!this.state.zenActive);
    shell.classList.toggle('theme-midnight', s.theme === 'midnight');
    shell.classList.toggle('theme-paper', s.theme === 'paper');
    shell.classList.toggle('theme-matrix', s.theme === 'matrix');
    shell.classList.toggle('theme-lavender', s.theme === 'lavender');
    shell.classList.toggle('theme-crimson', s.theme === 'crimson');
    document.body.classList.toggle('theme-midnight', s.theme === 'midnight');
    document.body.classList.toggle('theme-paper', s.theme === 'paper');
    document.body.classList.toggle('theme-matrix', s.theme === 'matrix');
    document.body.classList.toggle('theme-lavender', s.theme === 'lavender');
    document.body.classList.toggle('theme-crimson', s.theme === 'crimson');
    document.body.classList.toggle('reduce-mobile-animations', !!s.reduceMobileAnimations);
    shell.classList.toggle('compact', s.compactPanels);
    shell.classList.toggle('glow-enabled', s.cursorGlow);
    shell.classList.toggle('theme-experimental', !!s.experimentalDesign);
    shell.classList.toggle('indent-paragraphs', s.paragraphIndent);
    shell.classList.toggle('baseline-grid', s.baselineGrid);
    shell.classList.toggle('flexible-pages', !s.autoPaginate);
    shell.classList.toggle('hide-zen-button', !s.showZenButton);
    shell.classList.toggle('show-rulers', s.showPageRulers);
    shell.classList.toggle('sentence-focus-on', s.sentenceFocus);
    shell.classList.toggle('custom-caret-enabled', true);
    shell.classList.toggle('reduce-mobile-animations', !!s.reduceMobileAnimations);
    shell.classList.toggle('lens-dialogues', s.dialogueLens === 'dialogues');
    shell.classList.toggle('lens-descriptions', s.dialogueLens === 'descriptions');
    const caret = document.getElementById('custom-caret');
    caret?.classList.toggle('block', s.caretStyle === 'block');
    caret?.classList.toggle('underline', s.caretStyle === 'underline');
    caret?.classList.toggle('breath', s.caretBreath);
    document.querySelectorAll('[data-action="toggle-zen"]').forEach((button) => {
      button.classList.toggle('active', !!this.state.zenActive);
      button.setAttribute('aria-pressed', this.state.zenActive ? 'true' : 'false');
      button.title = this.state.zenActive ? 'Выйти из режима Дзен' : 'Режим Дзен';
    });
  }

  async persistSettings() {
    this.state.settings = this.validateSettings(this.state.settings);
    await this.db.put('settings', { id: 'app', value: this.state.settings });
    safeSetStorageItem(localStorage, 'nocturne_settings', JSON.stringify(this.state.settings));
  }

  clearAllLiveDrafts() {
    safeStorageKeys(localStorage).forEach((key) => {
      if (key.startsWith(LIVE_PREFIX)) safeRemoveStorageItem(localStorage, key);
    });
  }

  async resetSettings() {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-reset"></i></div>
        <h2>Сбросить настройки?</h2>
        <p>Документы, лор, заметки и снапшоты останутся. Будут сброшены только параметры интерфейса, редактора, ИИ и экспорта.</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" data-confirm-reset-settings>Сбросить</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-confirm-reset-settings]').onclick = async () => {
      this.state.settings = { ...defaultSettings };
      await this.persistSettings();
      overlay.classList.remove('active');
      this.applySettings();
      this.renderSettings();
      this.renderWorkspace();
      this.toast('Настройки сброшены.');
    };
  }

  aiContextOptions() {
    return {
      characters: this.state.settings.aiContextCharacters,
      locations: this.state.settings.aiContextLocations,
      timeline: this.state.settings.aiContextTimeline,
      subtimelines: this.state.settings.aiContextSubtimelines,
      rules: this.state.settings.aiContextRules,
      notes: this.state.settings.aiContextNotes,
    };
  }

  buildCurrentAiContext(doc = this.getFocusedDoc(), target = null) {
    if (!doc || !this.state.settings.aiKnowledgeContext) return null;
    const folder = this.state.folders.find((item) => item.id === doc.folderId);
    const context = buildAiContext({
      state: this.state,
      doc,
      target,
      folder,
      include: this.aiContextOptions(),
      budget: 7200,
    });
    this.lastAiContext = context;
    this.updateAiContextIndicator(context);
    return context;
  }

  updateAiContextIndicator(context = this.lastAiContext) {
    const el = document.getElementById('ai-context-budget');
    if (!el) return;
    if (!this.state.settings.aiKnowledgeContext || !context) {
      el.textContent = 'KB: off';
      return;
    }
    el.textContent = `${context.stats.size}/${context.stats.budget} знаков · П${context.stats.characters} Л${context.stats.locations} Т${context.stats.timeline}`;
  }

  openAiContextPreview() {
    const doc = this.getFocusedDoc();
    if (!doc) {
      this.toast('Откройте документ для preview context.');
      return;
    }
    const target = this.captureAssistantTargetSnapshot('proofread', doc, this.state.workspace?.focusedPaneId || 'primary')
      || { docId: doc.id, blockIndex: 0, targetBlockText: docText(doc.ast).slice(0, 1200) };
    const context = this.buildCurrentAiContext(doc, target) || { disabled: true, message: 'Knowledge Context выключен.' };
    const serialized = serializeAiContextSafe(context);
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal ai-context-preview-modal">
        <div class="modal-head-row">
          <div><h2>Knowledge Context Preview</h2><p>Read-only JSON, не вставляется в документ.</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="ai-context-stats">
          ${context.stats ? `
            <span>Characters: ${context.stats.characters}</span>
            <span>Locations: ${context.stats.locations}</span>
            <span>Таймлайн: ${context.stats.timeline}</span>
            <span>Subtimelines: ${context.stats.subtimelines}</span>
            <span>Notes: ${context.stats.notes}</span>
            <span>${context.stats.size} chars</span>
          ` : '<span>Context disabled</span>'}
        </div>
        <pre class="ai-context-preview" tabindex="0">${escapeHtml(serialized)}</pre>
        <div class="form-actions"><button class="pill-btn ai-btn" data-close-form>Закрыть</button></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelectorAll('[data-close-form]').forEach((button) => { button.onclick = () => overlay.classList.remove('active'); });
  }

  async runAi(kind) {
    if (kind === 'lore') kind = 'lore-check';
    if (this.activeAiRequest) {
      this.toast('Дождитесь завершения текущего AI-запроса.');
      return;
    }
    const context = this.ensureAssistantDocumentContext();
    if (!context.ok) return;
    if (kind === 'sentiment') {
      this.drawSentiment(true);
      this.setAssistantOutput('График тональности обновлен.');
      return;
    }
    if (!this.ensureAssistantProvider().ok) return;
    this.setAssistantBusy(kind);
    try {
      const paneId = this.state.workspace?.focusedPaneId || 'primary';
      const target = this.captureAssistantTargetSnapshot(kind, context.doc, paneId);
      if (!target && ['style', 'continue', 'proofread', 'lore-check'].includes(kind)) {
        const message = kind === 'continue' ? 'Поставьте курсор в место продолжения сцены.' : 'Поставьте курсор в абзац или выделите фрагмент.';
        this.toast(message);
        this.setAssistantOutput(message, 'error');
        return;
      }
      const request = {
        id: uid('ai-request'),
        docId: context.doc.id,
        paneId,
        target,
        kind,
        controller: new AbortController(),
        timeoutId: null,
      };
      request.timeoutId = window.setTimeout(() => request.controller.abort(new DOMException('AI timeout', 'AbortError')), 90_000);
      this.activeAiRequest = request;
      this.updateAssistantPanelState();
      const aiContext = this.buildCurrentAiContext(context.doc, target);
      const prompt = this.buildAiPrompt(kind, context.doc, target, aiContext);
      const budget = this.aiGenerationBudget(kind, target);
      const chunks = [];
      await this.streamAi(prompt, (chunk) => {
        chunks.push(chunk);
        this.handleAiProtocolPartial(chunks.join(''), request, kind);
      }, request.controller.signal, budget);
      if (this.activeAiRequest?.id !== request.id) return;
      const stillOpen = this.getPane(request.paneId)?.type === 'document' && this.getPane(request.paneId)?.docId === request.docId;
      if (!stillOpen) {
        this.setAssistantOutput('AI-запрос завершён, но исходный документ уже не открыт.', 'idle');
        this.toast('AI-результат не вставлен: исходная область изменилась.');
        return;
      }
      const rawResponse = chunks.join('');
      if (!rawResponse.trim()) throw new Error('Провайдер ИИ вернул пустой ответ.');
      const parsed = await this.parseAiProtocolWithRepair(rawResponse, prompt, budget, request);
      if (!parsed.ok) throw new Error(parsed.message || 'Модель вернула ответ в неожиданном формате. Текст в документ не вставлен.');
      if (parsed.thinking) this.setAssistantOutput(parsed.thinking, 'idle');
      if (parsed.writing?.text && parsed.writing.complete) {
        this.insertSuggestion(parsed.writing.text, { ok: true, doc: context.doc, paneId: request.paneId, target: request.target, kind, mode: parsed.writing.mode });
      }
      if (Array.isArray(parsed.review)) {
        const result = await this.createAiReviewMarks(parsed.review, context.doc, request.target);
        const suffix = result.skipped.length ? `\n\n${result.skipped.join('\n')}` : '';
        const emptyText = parsed.thinking || (kind === 'lore-check' ? 'Явных противоречий с лором не найдено.' : 'Явных ошибок не найдено.');
        this.setAssistantOutput(result.count ? `${parsed.thinking || 'Проверка завершена.'}\n\nНайдено проблем: ${result.count}.${suffix}` : `${emptyText}${suffix}`, result.count ? 'idle' : 'empty');
        if (!result.count) {
          this.hideReviewNavigatorIfNoMarks();
          this.toast('AI-проверка завершена: правок нет.', 1200);
        }
        if (result.count) {
          this.state.reviewMode = 'finalization';
          safeSetStorageItem(localStorage, 'nocturne-review-mode', 'finalization');
          this.applyReviewMode();
          this.renderReviewNavigator();
          this.updateReviewHighlights();
        }
      }
      if (!parsed.writing?.text && !Array.isArray(parsed.review) && !parsed.thinking) throw new Error('Модель вернула ответ в неожиданном формате.');
    } catch (error) {
      this.clearSuggestion();
      const message = error.name === 'AbortError' ? 'Запрос к ИИ слишком долго не отвечал.' : error.message || 'Ассистент не смог выполнить запрос.';
      this.setAssistantOutput(message, 'error');
      this.toast(message);
    } finally {
      if (this.activeAiRequest?.timeoutId) window.clearTimeout(this.activeAiRequest.timeoutId);
      this.activeAiRequest = null;
      this.assistantBusyKind = '';
      this.updateAssistantPanelState();
    }
  }

  captureAssistantTargetSnapshot(kind, doc = this.getFocusedDoc(), paneId = this.state.workspace?.focusedPaneId || 'primary') {
    const selection = this.selectionSnapshot?.docId === doc?.id ? this.selectionSnapshot : this.captureSelectionSnapshot();
    if (selection?.range && selection.docId === doc?.id && selection.text?.trim()) {
      const target = this.assistantTargetFromRange(selection.range, doc, paneId, selection.text);
      if (target) {
        this.assistantTargetSnapshot = { ...target, mode: kind === 'continue' ? 'continue-after-caret' : 'replace-selection' };
        if (kind === 'continue') this.assistantTargetSnapshot.startOffset = this.assistantTargetSnapshot.endOffset;
        return this.assistantTargetSnapshot;
      }
    }
    const caret = selection?.caret?.docId === doc?.id ? selection.caret : this.getCaretSnapshot();
    const block = doc?.ast?.blocks?.find((item) => item.id === caret?.blockId);
    if (!block) return null;
    const blockIndex = doc.ast.blocks.findIndex((item) => item.id === block.id);
    const text = blockText(block);
    const offset = Math.max(0, Math.min(text.length, Number(caret?.offset || text.length)));
    this.assistantTargetSnapshot = {
      docId: doc.id,
      paneId,
      mode: kind === 'continue' ? 'continue-after-caret' : 'rewrite-block',
      blockId: block.id,
      blockIndex,
      startOffset: kind === 'continue' ? offset : 0,
      endOffset: kind === 'continue' ? offset : text.length,
      selectedText: '',
      targetBlockText: text,
      contextBefore: text.slice(Math.max(0, offset - 700), offset),
      contextAfter: text.slice(offset, offset + 700),
    };
    return this.assistantTargetSnapshot;
  }

  assistantTargetFromRange(range, doc, paneId, selectedText) {
    const startBlock = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement)?.closest?.('[data-block-id]');
    const endBlock = (range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer : range.endContainer.parentElement)?.closest?.('[data-block-id]');
    if (!startBlock || !endBlock || startBlock.dataset.blockId !== endBlock.dataset.blockId) {
      this.toast('AI пока работает с выделением внутри одного абзаца.');
      return null;
    }
    const block = doc?.ast?.blocks?.find((item) => item.id === startBlock.dataset.blockId);
    if (!block) return null;
    const startPre = range.cloneRange();
    startPre.selectNodeContents(startBlock);
    startPre.setEnd(range.startContainer, range.startOffset);
    const endPre = range.cloneRange();
    endPre.selectNodeContents(startBlock);
    endPre.setEnd(range.endContainer, range.endOffset);
    const start = startPre.toString().length;
    const end = endPre.toString().length;
    const text = blockText(block);
    return {
      docId: doc.id,
      paneId,
      blockId: block.id,
      blockIndex: doc.ast.blocks.findIndex((item) => item.id === block.id),
      startOffset: start,
      endOffset: end,
      selectedText: selectedText || text.slice(start, end),
      targetBlockText: text,
      contextBefore: text.slice(Math.max(0, start - 700), start),
      contextAfter: text.slice(end, end + 700),
    };
  }

  buildAiPrompt(kind, doc = this.getFocusedDoc(), aiTarget = null, aiContext = null) {
    const fullText = docText(doc?.ast);
    const text = fullText.slice(-4200);
    const targetText = aiTarget?.selectedText || aiTarget?.targetBlockText || '';
    const entities = this.findRelevantLore(`${targetText}\n${text}`).map((item) => `${this.entityDisplayName(item) || item.title}: ${item.body}`).join('\n');
    const knowledgeContext = aiContext ? serializeAiContextSafe(aiContext) : '';
    const persona = {
      critic: 'Ты злой, точный литературный критик. Указывай на слабые места без комплиментов.',
      muse: 'Ты поэтичная муза. Предлагай образные, музыкальные решения.',
      coauthor: 'Ты соавтор. Сохраняй стиль автора и продолжай сцену аккуратно.',
    }[this.state.settings.aiPersona];
    const preferredMode = kind === 'continue' ? this.preferredContinuationMode(aiTarget) : aiTarget?.mode === 'replace-selection' ? 'replace-selection' : 'replace-block';
    const contract = `СТРОГИЙ JSON-КОНТРАКТ ОТВЕТА:
Верни ровно один JSON-объект без Markdown, без XML, без текста до или после JSON.

Для проверки текста или лора:
{
  "type": "review",
  "thinking": "краткий понятный пользователю итог проверки",
  "issues": [
    {
      "verdict": "issue",
      "category": "orthography|punctuation|grammar|style|repetition|lore|continuity",
      "quote": "точный фрагмент из проверяемого текста",
      "reason": "почему это реальная проблема",
      "replacement": "конкретная замена или пустая строка",
      "severity": "low|medium|high"
    }
  ]
}

Для переписывания или продолжения:
{
  "type": "writing",
  "thinking": "краткое понятное пользователю направление правки",
  "mode": "replace-selection|replace-block|inline-continuation|new-paragraph",
  "text": "только текст, который должен попасть в книгу"
}

Правила:
- Никаких XML-тегов и псевдопротоколов. Запрещены <NOCTURNE_PROTOCOL>, <SESSION_ID>, <REQUEST_TYPE>, <ANALYSIS_RESULTS>, <AI writing>, <AI review> и любые похожие теги.
- Не пиши Markdown-кодблоки.
- Не пиши "Конечно", "Вот результат", "Сейчас я".
- Не повторяй задачу пользователя.
- Не комментируй формат.
- Для review ОБЯЗАТЕЛЕН verdict: "issue"; похвала, "всё нормально", "соответствует лору" и любые non-issues не должны попадать в issues.
- Если thinking говорит, что ошибки/опечатки/проблемы найдены, issues НЕ МОЖЕТ быть пустым.
- Для корректуры каждая орфографическая, пунктуационная, грамматическая или повторная ошибка обязана иметь непустой replacement с готовой заменой.
- Если проблем нет, верни JSON: {"type":"review","thinking":"Явных ошибок не найдено.","issues":[]}.`;
    const modeInstruction = kind === 'proofread'
      ? `РЕЖИМ: ПРОВЕРИТЬ ТЕКСТ.
Проверка текста — это не беглый стилистический взгляд. Сначала внимательно прочитай каждое слово и найди явные механические опечатки, лишние/пропущенные буквы, повторяющиеся буквы, сломанные словоформы и очевидные орфографические и пунктуационные ошибки. Только после этого оцени грамматику и стиль.

ПОРЯДОК ПРОВЕРКИ:
1. Явные опечатки и неправильные словоформы.
2. Орфография.
3. Пунктуация.
4. Грамматика и согласование.
5. Явные тяжёлые повторы/стилистические сбои.

Обсценная, грубая, разговорная или неформальная лексика сама по себе НЕ является ошибкой. Но опечатка внутри грубого или разговорного слова всё равно ДОЛЖНА быть найдена.
Проверяй только реальные проблемы: орфографию, пунктуацию, грамматику, явные повторы и тяжёлые стилистические сбои, которые реально мешают чтению.
Не выдумывай ошибки. Если фраза допустима, литературна или просто эмоционально грубая, не создавай issue.
Если не уверен, лучше не создавай пометку.
Каждый issue обязан иметь verdict: "issue", точный quote из проверяемого текста и конкретный reason.
Replacement обязателен для каждой найденной орфографической, пунктуационной, грамматической ошибки, повтора и механической опечатки. Это должна быть готовая замена точного quote.
Если ты пишешь в thinking, что найдены механические опечатки, issues обязан содержать каждую такую опечатку с quote и replacement.
Не возвращай type="writing".

Примеры обязательного поведения:
Исходный текст: "Он ударил ублюдков срааных."
Правильный JSON:
{
  "type": "review",
  "thinking": "Найдена механическая опечатка.",
  "issues": [
  {
    "verdict": "issue",
    "category": "orthography",
    "quote": "срааных",
    "reason": "В слове лишняя буква «а». Нормальная форма — «сраных».",
    "replacement": "сраных",
    "severity": "medium"
  }
  ]
}
Подобные явные механические опечатки нельзя пропускать. Если ты возвращаешь пустой массив при наличии такой ошибки, ответ считается неверным.

Ещё примеры:
- "прекраасный день" → issue orthography, quote "прекраасный", replacement "прекрасный".
- "неождано" → issue orthography, quote "неождано", replacement "неожиданно".
- "Он сказал что придёт" → issue punctuation, quote "Он сказал что придёт", replacement "Он сказал, что придёт".

Перед тем как вернуть пустой массив issues, сделай внутреннюю финальную перепроверку: нет ли очевидных механических опечаток, лишних/пропущенных букв, нарушенной базовой пунктуации, и не пропущена ли ошибка только потому, что текст грубый или разговорный. Не выводи этот self-check пользователю.

Пример punctuation issue:
{
  "type": "review",
  "thinking": "Найдена пунктуационная ошибка.",
  "issues": [
  {
    "verdict": "issue",
    "category": "punctuation",
    "quote": "Он сказал что уйдёт",
    "reason": "Перед придаточным предложением нужна запятая.",
    "replacement": "Он сказал, что уйдёт",
    "severity": "medium"
  }
  ]
}
Если ошибок нет: {"type":"review","thinking":"Явных ошибок не найдено.","issues":[]}.`
      : kind === 'lore-check'
        ? `РЕЖИМ: ПРОВЕРИТЬ ЛОР.
Ищи только реальные противоречия между текстом и переданным lore context.
Не помечай стиль, бранные слова, удачные совпадения и фразы, которые соответствуют лору.
Никогда не создавай issue с reason вроде "соответствует лору", "ошибок нет", "корректно".
Lore issue создаётся только при явном несоответствии или подозрительной коллизии.
category используй только "lore" или "continuity".
quote — точная цитата проблемного места; reason — конкретно с чем конфликт; replacement может быть пустым.
Не возвращай type="writing".
Если противоречий нет: {"type":"review","thinking":"Явных противоречий с лором не найдено.","issues":[]}.`
        : kind === 'style'
          ? `РЕЖИМ: УЛУЧШИТЬ СТИЛЬ.
Верни JSON с "type":"writing", "mode":"${preferredMode}", "thinking" и "text".
В text перепиши только цель: ${preferredMode === 'replace-selection' ? 'выделенный фрагмент' : 'текущий абзац'}.
Не добавляй объяснения в text. Не расширяй радикально. Сохрани смысл, лицо, время, тон и авторский контекст. Не возвращай review/issues.`
          : `РЕЖИМ: ПРОДОЛЖИТЬ ФРАГМЕНТ.
Верни JSON с "type":"writing", "mode":"${preferredMode}", "thinking" и "text".
${preferredMode === 'inline-continuation' ? 'Нужно продолжить уже начатую мысль в том же абзаце. Не начинай новый абзац, не ставь перенос в начале, не повторяй уже написанное.' : 'Нужно добавить следующий короткий абзац после текущего блока. Не пересказывай уже написанное.'}
Не возвращай review/issues.`;
    return `${persona}

${contract}

${modeInstruction}

Knowledge context (справочно, не вставлять в документ):
${knowledgeContext || entities || 'Нет совпадений.'}

Контекст до цели:
${aiTarget?.contextBefore || text.slice(-1200)}

Целевой фрагмент:
${targetText || '(каретка без выделения)'}

Контекст после цели:
${aiTarget?.contextAfter || ''}

Фрагмент документа для стиля:
${text}`;
  }

  preferredContinuationMode(target = null) {
    const before = String(target?.contextBefore || target?.targetBlockText || '').trimEnd();
    if (!before) return 'new-paragraph';
    return /[.!?…»"]$/u.test(before) ? 'new-paragraph' : 'inline-continuation';
  }

  aiGenerationBudget(kind, target = null) {
    const words = countWords(target?.selectedText || target?.targetBlockText || '');
    if (['proofread', 'lore-check'].includes(kind)) return { maxTokens: 900 };
    if (kind === 'style' && target?.mode === 'replace-selection') return { maxTokens: Math.max(120, Math.min(420, words * 3 + 80)) };
    if (kind === 'style') return { maxTokens: Math.max(180, Math.min(520, words * 3 + 100)) };
    return { maxTokens: 360 };
  }

  sanitizeAssistantGeneratedText(text = '') {
    let clean = String(text || '').trim();
    clean = clean.replace(/^```(?:text|markdown|md)?\s*/i, '').replace(/```$/i, '').trim();
    clean = clean.replace(/^(?:конечно[,!.\s]+|вот\s+(?:улучшенный|переписанный)\s+вариант[:：]?\s*|результат[:：]\s*|улучшенный\s+вариант[:：]\s*)/iu, '').trim();
    clean = clean.replace(/^["«](.*)["»]$/su, '$1').trim();
    return clean;
  }

  sanitizeAssistantJsonText(text = '') {
    let clean = String(text || '').trim();
    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    return clean;
  }

  parseAiJsonResponse(raw = '') {
    const source = this.sanitizeAssistantJsonText(raw);
    if (!source) return { ok: false, message: 'AI вернул пустой JSON.' };
    if (this.containsForeignProtocolMarkup(source)) {
      return { ok: false, foreignProtocol: true, message: 'AI вернул служебный XML/protocol вместо JSON.' };
    }
    let payload;
    try {
      payload = JSON.parse(source);
    } catch {
      return { ok: false, message: 'AI вернул некорректный JSON.' };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, message: 'AI JSON должен быть объектом.' };
    }
    const type = String(payload.type || '').trim();
    const thinking = String(payload.thinking || '').trim();
    if (type === 'writing') {
      const mode = String(payload.mode || '').trim();
      const text = this.sanitizeAssistantGeneratedText(payload.text || '');
      if (!['replace-selection', 'replace-block', 'inline-continuation', 'new-paragraph'].includes(mode)) {
        return { ok: false, message: 'AI writing содержит неизвестный режим вставки.' };
      }
      if (!text) return { ok: false, message: 'AI writing не содержит текста.' };
      if (this.containsUnsafeAiOutput(text)) return { ok: false, message: 'AI writing содержит служебный протокол вместо текста.' };
      return { ok: true, thinking, writing: { mode, text, complete: true }, review: null, reviewError: '', unexpected: false, foreignProtocol: false };
    }
    if (type === 'review') {
      const issues = Array.isArray(payload.issues) ? payload.issues : null;
      if (!issues) return { ok: false, message: 'AI review должен содержать массив issues.' };
      return { ok: true, thinking, writing: null, review: issues, reviewError: '', unexpected: false, foreignProtocol: false };
    }
    return { ok: false, message: 'AI JSON содержит неизвестный type.' };
  }

  parseAiProtocol(buffer = '', partial = false) {
    const source = String(buffer || '');
    const foreignProtocol = !partial && this.containsForeignProtocolMarkup(source);
    const extract = (tag) => {
      const complete = source.match(new RegExp(`<AI ${tag}[^>]*>([\\s\\S]*?)<\\/AI ${tag}>`, 'i'));
      if (complete) return { text: complete[1].trim(), complete: true, raw: complete[0] };
      if (!partial) return null;
      const open = source.match(new RegExp(`<AI ${tag}[^>]*>([\\s\\S]*)$`, 'i'));
      return open ? { text: open[1].trim(), complete: false, raw: open[0] } : null;
    };
    const thinking = extract('thinking');
    const writingMatch = source.match(/<AI writing(?:\s+mode="([^"]+)")?\s*>([\s\S]*?)(?:<\/AI writing>|$)/i);
    const writingComplete = /<AI writing(?:\s+mode="([^"]+)")?\s*>[\s\S]*?<\/AI writing>/i.test(source);
    const review = extract('review');
    let reviewItems = null;
    let reviewError = '';
    if (review?.complete) {
      try {
        const reviewText = review.text.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(reviewText);
        if (!Array.isArray(parsed)) {
          reviewError = 'AI review должен быть JSON-массивом.';
          reviewItems = null;
        } else {
          reviewItems = parsed;
        }
      } catch {
        reviewError = 'Не удалось разобрать список найденных проблем.';
        reviewItems = null;
      }
    }
    const hasUnclosedTag = !partial && /<AI (thinking|writing|review)\b/i.test(source)
      && (
        (/<AI thinking\b/i.test(source) && !/<\/AI thinking>/i.test(source))
        || (/<AI writing\b/i.test(source) && !/<\/AI writing>/i.test(source))
        || (/<AI review\b/i.test(source) && !/<\/AI review>/i.test(source))
      );
    const stripped = source
      .replace(/<AI thinking>[\s\S]*?(?:<\/AI thinking>|$)/ig, '')
      .replace(/<AI writing(?:\s+mode="[^"]+")?>[\s\S]*?(?:<\/AI writing>|$)/ig, '')
      .replace(/<AI review>[\s\S]*?(?:<\/AI review>|$)/ig, '')
      .trim();
    return {
      thinking: thinking?.text || '',
      writing: writingMatch ? {
        mode: writingMatch[1] || '',
        text: this.sanitizeAssistantGeneratedText(writingMatch[2] || ''),
        complete: writingComplete,
      } : null,
      review: reviewItems,
      reviewError,
      foreignProtocol,
      unexpected: !partial && (!!stripped || hasUnclosedTag),
    };
  }

  handleAiProtocolPartial(buffer, request, kind) {
    const parsed = this.parseAiProtocol(buffer, true);
    if (parsed.thinking) this.setAssistantOutput(parsed.thinking, 'busy');
    if (parsed.writing?.text && parsed.writing.complete && ['style', 'continue'].includes(kind) && !this.containsUnsafeAiOutput(parsed.writing.text)) {
      const doc = this.state.docs.find((item) => item.id === request.docId);
      if (doc) this.insertSuggestion(parsed.writing.text, { ok: true, doc, paneId: request.paneId, target: request.target, kind, mode: parsed.writing.mode, streaming: !parsed.writing.complete, silent: true });
    }
  }

  containsAiProtocolMarkup(text = '') {
    return this.containsUnsafeAiOutput(text);
  }

  containsForeignProtocolMarkup(text = '') {
    const value = String(text || '');
    const withoutNocturneTags = value.replace(/<\/?AI\s+(?:thinking|writing|review)(?:\s+mode="[^"]+")?\s*>/ig, '');
    const knownProtocolTag = /<\/?(?:NOCTURNE_PROTOCOL|SESSION_ID|TIMESTAMP|AGENT_ID|REQUEST_TYPE|ORIGINAL_CONTENT|ANALYSIS_RESULTS|ISSUE_IDENTIFIED|CATEGORY|SUBCATEGORY|DESCRIPTION|RECOMMENDATION|CONCLUSION)\b/iu;
    const uppercaseXmlTag = /<\/?[A-Z][A-Z0-9_:-]*(?:\s[^>]*)?>/u;
    const xmlDeclaration = /<\?xml\b|<!DOCTYPE\b/iu;
    return knownProtocolTag.test(withoutNocturneTags) || uppercaseXmlTag.test(withoutNocturneTags) || xmlDeclaration.test(withoutNocturneTags);
  }

  containsUnsafeAiOutput(text = '') {
    const value = String(text || '');
    return /<\/?AI\s+(?:thinking|writing|review)\b/iu.test(value)
      || this.containsForeignProtocolMarkup(value)
      || /^\s*[\[{]\s*"?(?:category|quote|verdict|replacement|reason)"?/iu.test(value);
  }

  expectedAiProtocolForKind(kind) {
    if (['proofread', 'lore-check'].includes(kind)) return 'review';
    if (['style', 'continue'].includes(kind)) return 'writing';
    return 'any';
  }

  validateParsedAiProtocol(parsed, kind = '') {
    const expected = this.expectedAiProtocolForKind(kind);
    const hasWriting = !!parsed.writing?.text;
    const hasReview = Array.isArray(parsed.review);
    if (parsed.foreignProtocol) return 'Модель вернула служебный XML/protocol вместо ответа Nocturne. Текст в документ не вставлен.';
    if (parsed.unexpected) return 'Модель добавила текст или теги вне протокола Nocturne. Текст в документ не вставлен.';
    if (parsed.reviewError) return parsed.reviewError;
    if (parsed.writing?.text && (!parsed.writing.complete || this.containsUnsafeAiOutput(parsed.writing.text))) return 'Модель вернула небезопасный текст для вставки. Документ не изменён.';
    if (expected === 'review' && hasWriting) return 'Модель вернула текст для вставки вместо списка замечаний. Документ не изменён.';
    if (expected === 'writing' && hasReview) return 'Модель вернула review вместо текста правки. Документ не изменён.';
    if (expected === 'review' && !hasReview) return 'Модель не вернула корректный AI review.';
    if (expected === 'review') {
      const reviewMessage = this.validateAiReviewActionability(parsed.review, kind, parsed.thinking);
      if (reviewMessage) return reviewMessage;
    }
    if (expected === 'writing' && !hasWriting) return 'Модель не вернула корректный AI writing.';
    return '';
  }

  aiReviewThinkingClaimsIssues(thinking = '') {
    const text = String(thinking || '').toLowerCase();
    if (!text.trim()) return false;
    const negative = /(не\s+найден|не\s+обнаружен|нет\s+(?:ошиб|опечат|проблем|правок)|ошибок\s+нет|опечаток\s+нет|проблем\s+нет|правок\s+нет|без\s+(?:ошиб|опечат|проблем)|явных\s+(?:ошиб|опечат|проблем)\s+не\s+найден)/iu;
    if (negative.test(text)) return false;
    return /(найден|обнаружен|есть|исправ|опечат|ошиб|проблем|замен|правк|пунктуац|граммат|орфограф|механическ)/iu.test(text);
  }

  validateAiReviewActionability(issues = [], kind = '', thinking = '') {
    if (!Array.isArray(issues)) return 'Модель не вернула корректный AI review.';
    if (!issues.length && this.aiReviewThinkingClaimsIssues(thinking)) {
      return 'Модель написала, что нашла ошибки, но не вернула список issues с конкретными заменами.';
    }
    if (kind !== 'proofread') return '';
    const actionableCategories = new Set(['orthography', 'punctuation', 'grammar', 'repetition']);
    const missingReplacement = issues.some((raw) => (
      raw
      && raw.verdict === 'issue'
      && actionableCategories.has(this.aiIssueCategory(raw.category))
      && !String(raw.replacement || '').trim()
    ));
    if (missingReplacement) {
      return 'Модель нашла ошибки корректуры, но не дала replacement для готовой замены.';
    }
    return '';
  }

  async parseAiProtocolWithRepair(raw, originalPrompt, budget, request) {
    let parsed = this.parseAiJsonResponse(raw);
    let invalidMessage = parsed.ok ? this.validateParsedAiProtocol(parsed, request?.kind) : (parsed.message || 'AI вернул некорректный формат.');
    let invalid = !parsed.ok || !!invalidMessage;
    if (invalid) {
      const legacy = this.parseAiProtocol(raw, false);
      const legacyMessage = this.validateParsedAiProtocol(legacy, request?.kind);
      if (!legacyMessage && !legacy.foreignProtocol) return { ...legacy, ok: true, legacy: true };
    }
    if (!invalid) return { ...parsed, ok: true };
    this.clearSuggestion();
    const repairPrompt = this.buildAiRepairPrompt(raw, request?.kind || '');
    const repairedChunks = [];
    try {
      await this.streamAi(repairPrompt, (chunk) => repairedChunks.push(chunk), request?.controller?.signal || null, { maxTokens: Math.max(500, budget?.maxTokens || 500) });
      parsed = this.parseAiJsonResponse(repairedChunks.join(''));
      invalidMessage = parsed.ok ? this.validateParsedAiProtocol(parsed, request?.kind) : (parsed.message || 'AI вернул некорректный формат.');
      invalid = !parsed.ok || !!invalidMessage;
      if (invalid) {
        const legacy = this.parseAiProtocol(repairedChunks.join(''), false);
        const legacyMessage = this.validateParsedAiProtocol(legacy, request?.kind);
        if (!legacyMessage && !legacy.foreignProtocol) return { ...legacy, ok: true, legacy: true };
      }
      if (!invalid) return { ...parsed, ok: true };
      return { ...parsed, ok: false, message: invalidMessage || 'AI вернул некорректный формат. Текст не изменён.' };
    } catch {
      return { ...parsed, ok: false, message: invalidMessage || parsed.reviewError || 'AI вернул некорректный формат. Текст не изменён.' };
    }
  }

  buildAiRepairPrompt(raw, kind = '') {
    const proofreadRules = kind === 'proofread' ? `
Дополнительные правила корректуры:
- Если в thinking сказано, что найдены ошибки, issues обязан быть непустым.
- Для каждой орфографической, пунктуационной, грамматической ошибки, повтора или механической опечатки обязателен непустой replacement.
- replacement должен быть готовой заменой точного quote.
- Если в предыдущем ответе есть только общий итог без конкретных quote/replacement, заново извлеки конкретные ошибки из предыдущего ответа; если их нельзя извлечь, верни {"type":"review","thinking":"AI не смог выделить конкретные замены.","issues":[]}.` : '';
    return `Переформатируй предыдущий ответ строго в JSON Nocturne. Не меняй смысл и не добавляй новых выводов.

Разрешены только два варианта JSON-объекта:
{"type":"review","thinking":"...","issues":[{"verdict":"issue","category":"orthography|punctuation|grammar|style|repetition|lore|continuity","quote":"...","reason":"...","replacement":"","severity":"low|medium|high"}]}
{"type":"writing","thinking":"...","mode":"replace-selection|replace-block|inline-continuation|new-paragraph","text":"..."}

Правила:
- Верни только JSON-объект.
- Текст вне JSON запрещён.
- XML и псевдопротоколы запрещены.
- Только объекты с "verdict":"issue" остаются в issues.
- Если thinking говорит, что проблемы найдены, issues не должен быть пустым.
- Если проблем нет, issues должен быть [].
- Не используй markdown-кодблоки.
${proofreadRules}

Предыдущий ответ:
${raw}`;
  }

  async createAiReviewMarks(issues = [], doc, target = null) {
    let count = 0;
    const skipped = [];
    const validated = this.validateAiReviewIssues(issues, doc, target, skipped);
    for (const issue of validated) {
      const quote = issue.quote;
      const anchor = this.findAiIssueAnchor(doc, quote, target);
      if (!anchor) {
        skipped.push('Одна из AI-пометок была пропущена: фрагмент не найден в тексте.');
        continue;
      }
      await this.saveReviewMark({
        id: uid('review-ai'),
        docId: doc.id,
        kind: issue.replacement ? 'suggestion' : 'issue',
        category: issue.category,
        colorKey: issue.category,
        ...anchor,
        comment: `[AI] ${issue.reason}`,
        suggestion: issue.replacement,
        source: 'ai',
        severity: issue.severity,
        status: 'open',
        createdAt: Date.now(),
      });
      count += 1;
    }
    return { count, skipped: [...new Set(skipped)].slice(0, 3) };
  }

  validateAiReviewIssues(issues = [], doc, target = null, skipped = []) {
    if (!Array.isArray(issues)) {
      skipped.push('Не удалось разобрать список найденных проблем.');
      return [];
    }
    const targetText = this.aiTargetReviewText(doc, target);
    return issues.map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      if (raw.verdict !== 'issue') return null;
      const category = this.aiIssueCategory(raw.category);
      const quote = String(raw.quote || '').trim();
      const reason = String(raw.reason || '').trim();
      const replacement = String(raw.replacement || '').trim();
      const severity = ['low', 'medium', 'high'].includes(raw.severity) ? raw.severity : 'medium';
      if (!category || !quote || !reason) return null;
      if (this.aiIssueLooksLikeNonIssue({ reason, replacement })) return null;
      if (!targetText.includes(quote)) {
        skipped.push('Одна из AI-пометок была пропущена: фрагмент не найден в тексте.');
        return null;
      }
      return { verdict: 'issue', category, quote, reason, replacement, severity };
    }).filter(Boolean);
  }

  aiTargetReviewText(doc, target = null) {
    if (target?.selectedText) return target.selectedText;
    if (target?.targetBlockText) return target.targetBlockText;
    return docText(doc?.ast || null);
  }

  aiIssueLooksLikeNonIssue(issue = {}) {
    const combined = `${issue.reason || ''} ${issue.replacement || ''}`.toLowerCase();
    const nonIssue = /(соответствует|ошибок\s+нет|корректно|нормально|не\s+требует\s+исправления|проблем\s+нет|допустим[ао]?)/iu.test(combined);
    const concreteProblem = /(нужн[аоы]?|ошибк|противореч|конфликт|повтор|неверн|лишн|пропущ|согласован|запята|пунктуац|граммат|орфограф)/iu.test(combined);
    return nonIssue && !concreteProblem;
  }

  aiIssueCategory(category = '') {
    const clean = String(category || '').trim();
    return ['orthography', 'punctuation', 'grammar', 'style', 'repetition', 'lore', 'continuity'].includes(clean) ? clean : '';
  }

  findAiIssueAnchor(doc, quote, target = null) {
    const blocks = doc?.ast?.blocks || [];
    const preferred = target?.blockId ? [blocks.find((block) => block.id === target.blockId), ...blocks.filter((block) => block.id !== target.blockId)] : blocks;
    for (const block of preferred.filter(Boolean)) {
      const text = blockText(block);
      const start = this.findBestQuoteOffset(text, quote, '', '');
      if (start < 0) continue;
      const end = start + quote.length;
      return {
        start: { blockId: block.id, offset: start },
        end: { blockId: block.id, offset: end },
        quote,
        prefix: text.slice(Math.max(0, start - 36), start),
        suffix: text.slice(end, end + 36),
      };
    }
    return null;
  }

  async streamAi(prompt, onChunk, signal = null, budget = {}) {
    const s = this.state.settings;
    const providerProblem = this.assistantProviderProblem();
    if (providerProblem) throw new Error(providerProblem);
    const endpoint = s.aiProvider === 'gemini' && s.aiKey ? `${s.aiEndpoint}?key=${encodeURIComponent(s.aiKey)}` : s.aiEndpoint;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.aiHeaders(),
      body: JSON.stringify(this.aiRequestBody(prompt, budget)),
      signal,
    });
    if (!response.ok) throw new Error(`Ошибка провайдера ИИ: HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Провайдер ИИ не вернул поток ответа.');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const tail = this.extractStreamText(buffer, true);
        if (tail) onChunk(tail);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lastBreak = buffer.lastIndexOf('\n');
      if (lastBreak < 0) continue;
      const complete = buffer.slice(0, lastBreak + 1);
      buffer = buffer.slice(lastBreak + 1);
      const text = this.extractStreamText(complete);
      if (text) onChunk(text);
    }
  }

  aiHeaders() {
    const s = this.state.settings;
    const headers = { 'Content-Type': 'application/json' };
    if (s.aiProvider === 'anthropic') {
      headers['x-api-key'] = s.aiKey;
      headers['anthropic-version'] = '2023-06-01';
      return headers;
    }
    if (s.aiKey && s.aiProvider !== 'gemini') headers.Authorization = `Bearer ${s.aiKey}`;
    return headers;
  }

  aiRequestBody(prompt, budget = {}) {
    const s = this.state.settings;
    const maxTokens = budget.maxTokens || 420;
    if (s.aiProvider === 'ollama') return { model: s.aiModel, prompt, stream: true, format: 'json', options: { temperature: s.aiTemperature, num_predict: maxTokens } };
    if (s.aiProvider === 'gemini') {
      return {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: s.aiTemperature,
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
          responseSchema: this.aiJsonResponseSchema(),
        },
      };
    }
    if (s.aiProvider === 'anthropic') return { model: s.aiModel, max_tokens: maxTokens, stream: true, temperature: s.aiTemperature, messages: [{ role: 'user', content: prompt }] };
    return { model: s.aiModel, messages: [{ role: 'user', content: prompt }], stream: true, temperature: s.aiTemperature, max_tokens: maxTokens, response_format: { type: 'json_object' } };
  }

  aiJsonResponseSchema() {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['review', 'writing'] },
        thinking: { type: 'string' },
        mode: { type: 'string', enum: ['replace-selection', 'replace-block', 'inline-continuation', 'new-paragraph'] },
        text: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              verdict: { type: 'string', enum: ['issue'] },
              category: { type: 'string', enum: ['orthography', 'punctuation', 'grammar', 'style', 'repetition', 'lore', 'continuity'] },
              quote: { type: 'string' },
              reason: { type: 'string' },
              replacement: { type: 'string' },
              severity: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            required: ['verdict', 'category', 'quote', 'reason', 'severity'],
          },
        },
      },
      required: ['type'],
    };
  }

  extractStreamText(chunk, flush = false) {
    return chunk
      .split('\n')
      .filter((line, index, arr) => flush || index < arr.length - 1 || line.endsWith('\n'))
      .map((line) => line.replace(/^data:\s*/, '').trim())
      .filter((line) => line && line !== '[DONE]' && !line.startsWith('event:'))
      .map((line) => {
        try {
          const json = JSON.parse(line);
          return json.response || json.choices?.[0]?.delta?.content || json.candidates?.[0]?.content?.parts?.[0]?.text || json.delta?.text || json.content?.[0]?.text || '';
        } catch {
          return '';
        }
      }).join('');
  }

  localAiText() {
    throw new Error('Ассистент не настроен. Выберите провайдера или подключите Ollama.');
  }

  findRelevantLore(text) {
    const lower = normalizeTypoToken(text);
    return [...this.state.lore.characters, ...this.state.lore.locations, ...this.state.lore.timeline]
      .filter((item) => {
        const values = item.title ? [item.title] : this.entityMentionValues(item);
        return values.filter(Boolean).some((alias) => lower.includes(normalizeTypoToken(alias)));
      });
  }

  checkLore() {
    const doc = this.getFocusedDoc();
    const text = docText(doc?.ast);
    const issues = [];
    if (/Эрион[^.?!…]{0,80}голубые глаза|голубые глаза[^.?!…]{0,80}Эрион/i.test(text)) {
      issues.push('Конфликт: у Эриона в лоре карие глаза, в тексте найдены голубые.');
    }
    const normalizedText = normalizeTypoToken(text);
    [...this.state.lore.characters, ...this.state.lore.locations].forEach((entity) => {
      const matched = this.entityMentionValues(entity).some((alias) => alias && normalizedText.includes(normalizeTypoToken(alias)));
      if (!matched) return;
      if (!entity.documentIds?.includes(doc.id)) issues.push(`Связь добавлена: ${this.entityDisplayName(entity)} фигурирует в текущей главе.`);
      entity.documentIds = [...new Set([...(entity.documentIds || []), doc.id])];
    });
    this.saveLore();
    return issues.length ? issues.join('\n') : 'Проверка лора завершена: явных конфликтов не найдено.';
  }

  hasHardLoreConflict(doc = this.activeDoc) {
    if (Number(this.state.settings.loreStrictness) < 65) return false;
    const text = docText(doc?.ast);
    return /Эрион[^.?!…]{0,80}голубые глаза|голубые глаза[^.?!…]{0,80}Эрион/i.test(text);
  }

  updateAssistantPanelState() {
    const docMessage = this.assistantDocumentProblem();
    const providerMessage = this.assistantProviderProblem();
    const busy = !!this.activeAiRequest;
    document.querySelectorAll('.ai-card').forEach((card) => {
      const disabled = !!docMessage || busy;
      card.toggleAttribute('disabled', disabled);
      card.classList.toggle('disabled', disabled);
      card.title = docMessage ? 'Откройте или создайте документ, чтобы использовать ассистента.' : busy ? 'Дождитесь завершения текущего AI-запроса.' : '';
    });
    const output = document.getElementById('ai-output');
    if (!output) return;
    if (busy) {
      output.dataset.tone = 'busy';
      output.textContent = this.assistantPanelMessage || this.assistantBusyMessage();
      return;
    }
    if (docMessage) {
      this.assistantState = 'no-document';
      this.assistantPanelMessage = docMessage;
      output.dataset.tone = 'empty';
      output.innerHTML = '<strong>Нет активного документа</strong><span>Откройте или создайте рукопись, чтобы ассистент мог анализировать и предлагать изменения.</span>';
    } else if (providerMessage && !['error', 'empty'].includes(this.assistantState)) {
      this.assistantState = 'provider-missing';
      this.assistantPanelMessage = providerMessage;
      output.dataset.tone = 'empty';
      output.innerHTML = '<strong>Ассистент не подключён</strong><span>Выберите провайдера в настройках ИИ.</span>';
    } else if (!this.assistantPanelMessage || ['busy', 'no-document', 'provider-missing'].includes(this.assistantState)) {
      this.assistantState = 'idle';
      this.assistantPanelMessage = 'Готов к работе.';
      output.dataset.tone = 'idle';
      output.textContent = 'Готов к работе.';
    } else {
      output.dataset.tone = this.assistantState || 'idle';
      output.textContent = this.assistantPanelMessage;
    }
  }

  clearSuggestionIfStale() {
    if (!this.state.suggestion) {
      document.getElementById('suggestion-bar')?.classList.remove('active');
      return;
    }
    const pane = this.getPane(this.state.suggestion.paneId);
    if (pane?.type !== 'document' || pane.docId !== this.state.suggestion.docId) this.clearSuggestion();
  }

  clearSuggestion() {
    const previous = this.state.suggestion;
    if (this.aiSuggestionTimer) {
      clearInterval(this.aiSuggestionTimer);
      this.aiSuggestionTimer = null;
    }
    document.getElementById('suggestion-bar')?.classList.remove('active');
    this.state.suggestion = null;
    this.updateSuggestionBarState();
    if (previous?.paneId) this.renderWorkspacePane(previous.paneId);
  }

  insertSuggestion(text, context = this.ensureAssistantDocumentContext({ showToast: false, updateOutput: false })) {
    if (!text.trim() || !context?.ok) return false;
    if (this.containsAiProtocolMarkup(text)) {
      this.setAssistantOutput('Модель вернула ответ в неожиданном формате. Текст в документ не вставлен.', 'error');
      this.toast('AI-ответ не вставлен: нарушен формат.');
      return false;
    }
    const doc = context.doc;
    const paneId = context.paneId || this.state.workspace?.focusedPaneId || 'primary';
    const target = context.target || this.assistantTargetSnapshot;
    let mode = context.mode || (context.kind === 'continue' ? this.preferredContinuationMode(target) : target?.mode === 'replace-selection' ? 'replace-selection' : 'replace-block');
    if (context.kind === 'continue' && this.preferredContinuationMode(target) === 'inline-continuation') mode = 'inline-continuation';
    this.clearSuggestion();
    this.state.suggestion = {
      id: uid('suggestion'),
      docId: doc.id,
      paneId,
      text,
      kind: context.kind || 'style',
      mode,
      target,
      streaming: !!context.streaming,
    };
    document.getElementById('suggestion-bar')?.classList.add('active');
    this.updateSuggestionBarState();
    this.renderWorkspacePane(paneId);
    if (!context.silent) {
      this.setAssistantOutput(text, 'idle');
      this.toast(context.kind === 'continue' ? 'AI-продолжение готово. Проверьте и примите вставку.' : 'AI-замена готова. Проверьте и примите правку.');
    }
    return true;
  }

  acceptSuggestion() {
    this.clearSuggestionIfStale();
    if (!this.state.suggestion) return;
    if (this.state.suggestion.streaming) {
      this.toast('Дождитесь завершения предложения AI.');
      return;
    }
    const suggestion = this.state.suggestion;
    if (!this.applyAssistantSuggestionPatch(suggestion)) return;
    this.clearSuggestion();
  }

  updateSuggestionBarState() {
    const accept = document.querySelector('#suggestion-bar [data-action="accept-ai"]');
    if (accept) accept.toggleAttribute('disabled', !!this.state.suggestion?.streaming);
  }

  rejectSuggestion() {
    this.clearSuggestion();
  }

  applyAssistantSuggestionPatch(suggestion) {
    const doc = this.state.docs.find((item) => item.id === suggestion?.docId);
    const target = suggestion?.target;
    if (!doc || !target) return false;
    if (this.containsUnsafeAiOutput(suggestion.text)) {
      this.clearSuggestion();
      this.setAssistantOutput('AI-предложение отклонено: модель вернула служебный протокол вместо текста.', 'error');
      this.toast('AI-ответ не применён: нарушен формат.');
      return false;
    }
    const blockIndex = doc.ast.blocks.findIndex((block) => block.id === target.blockId);
    const block = doc.ast.blocks[blockIndex];
    if (!block) {
      this.toast('AI-результат готов, но место вставки изменилось. Повторите запрос.');
      return false;
    }
    if (suggestion.mode === 'inline-continuation') {
      const offset = Math.max(0, Math.min(blockText(block).length, Number(target.startOffset || blockText(block).length)));
      block.html = this.replaceInHtmlRange(block.html, offset, offset, suggestion.text);
    } else if (suggestion.mode === 'new-paragraph' || target.mode === 'continue-after-caret') {
      const parts = this.aiTextToBlocks(suggestion.text);
      if (!parts.length) return false;
      const offset = Math.max(0, Math.min(blockText(block).length, Number(target.startOffset || blockText(block).length)));
      const currentText = blockText(block);
      if (offset <= 0) {
        doc.ast.blocks.splice(blockIndex, 0, ...parts);
      } else if (offset >= currentText.length - 1) {
        doc.ast.blocks.splice(blockIndex + 1, 0, ...parts);
      } else {
        const [beforeHtml, afterHtml] = this.splitHtmlAtTextOffset(block.html, offset);
        block.html = beforeHtml || '<br>';
        const afterBlock = { ...block, id: uid('block'), html: afterHtml || '<br>' };
        doc.ast.blocks.splice(blockIndex + 1, 0, ...parts, afterBlock);
      }
    } else if (target.mode === 'replace-selection') {
      const current = blockText(block).slice(target.startOffset, target.endOffset);
      if (current !== target.selectedText) {
        this.toast('AI-результат готов, но исходный фрагмент изменился. Повторите запрос.');
        return false;
      }
      block.html = this.replaceInHtmlRange(block.html, target.startOffset, target.endOffset, suggestion.text);
    } else {
      block.html = normalizeHtml(escapeHtml(suggestion.text).replace(/\n/g, '<br>') || '<br>');
    }
    doc.updatedAt = Date.now();
    doc.summary = doc.description || buildSummary(doc.ast);
    this.bumpDocRenderRevision(doc);
    this.writeLiveDraft(doc.id);
    this.saveDocByIdDebounced(doc.id);
    this.renderWorkspacePane(suggestion.paneId || this.state.workspace?.focusedPaneId || 'primary');
    this.toast('AI-предложение применено.');
    return true;
  }

  aiTextToBlocks(text = '') {
    return String(text || '')
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => ({ id: uid('block'), type: 'paragraph', html: normalizeHtml(escapeHtml(part).replace(/\n/g, '<br>')) }));
  }

  splitHtmlAtTextOffset(html = '', offset = 0) {
    const div = document.createElement('div');
    div.innerHTML = html || '<br>';
    const { textNodes, fullText } = this.textNodesForHighlightBlock(div);
    const safeOffset = Math.max(0, Math.min(fullText.length, Number(offset || 0)));
    const range = this.rangeFromBlockOffsets(textNodes, safeOffset, safeOffset);
    if (!range) return [normalizeHtml(div.innerHTML || '<br>'), ''];
    const before = document.createRange();
    before.selectNodeContents(div);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(div);
    after.setStart(range.startContainer, range.startOffset);
    const left = document.createElement('div');
    const right = document.createElement('div');
    left.appendChild(before.cloneContents());
    right.appendChild(after.cloneContents());
    return [normalizeHtml(left.innerHTML || '<br>'), normalizeHtml(right.innerHTML || '<br>')];
  }

  drawSentiment(force = false) {
    if (!this.state.settings.sentimentTimeline && !force) return;
    const canvas = document.getElementById('sentiment-graph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sentences = (docText(this.getFocusedDoc()?.ast).match(/[^.!?…]+[.!?…]?/g) || []).slice(-24);
    const hot = ['кровь', 'страх', 'удар', 'огонь', 'смерть', 'боль', 'крик', 'опасность'];
    const calm = ['тихо', 'мягко', 'спокойно', 'свет', 'дождь', 'сон'];
    const values = sentences.map((sentence) => {
      const lower = sentence.toLowerCase();
      return 24 + hot.filter((w) => lower.includes(w)).length * 16 - calm.filter((w) => lower.includes(w)).length * 8 + Math.min(18, countWords(sentence));
    });
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * canvas.width;
      const y = canvas.height - Math.max(8, Math.min(canvas.height - 8, value));
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  startSprint() {
    if (this.state.sprint || this.sprintTimer) {
      this.toast('Спринт уже идёт.');
      return;
    }
    const minutes = Number(this.state.settings.sprintMinutes);
    const endsAt = Date.now() + minutes * 60_000;
    this.state.sprint = { endsAt, locked: this.state.settings.sprintLock };
    this.toggleZen(true);
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      if (!left) {
        clearInterval(this.sprintTimer);
                this.state.sprint = null;
        this.toast('Спринт завершен. Дзен-режим остаётся включённым.');
        this.confetti();
        return;
      }
      this.toast(`Спринт: осталось ${Math.ceil(left / 60000)} мин.`, 900);
    };
        tick();
  }

  async showHistory() {
    const snapshots = (await this.db.getAll('snapshots')).filter((snap) => snap.docId === this.state.activeDocId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal">
        <h2>Машина времени</h2>
        <div class="form-grid">
          ${snapshots.length ? snapshots.map((snap) => `<button class="history-item" data-restore="${snap.id}"><strong>${new Date(snap.createdAt).toLocaleString()}</strong><span>${escapeHtml(snap.summary || snap.title || '')}</span><small>${snap.wordCount || countWords(docText(snap.ast))} слов</small></button>`).join('') : '<p class="doc-desc">Снапшотов пока нет. Нажмите кнопку камеры на панели инструментов, чтобы создать первый снимок.</p>'}
        </div>
        <div class="form-actions"><button class="pill-btn" data-close-form>Закрыть</button></div>
      </div>
    `;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelectorAll('[data-restore]').forEach((button) => button.onclick = async () => {
      const snap = snapshots.find((item) => item.id === button.dataset.restore);
      if (!snap) return;
      this.activeDoc.ast = structuredClone(snap.ast);
      this.activeDoc.summary = buildSummary(this.activeDoc.ast);
      await this.saveActiveDoc({ silent: true });
      overlay.classList.remove('active');
      this.renderAll();
    });
  }

  async checksumText(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return String(this.crc32(bytes));
  }

  async buildNocturneDump(options = {}) {
    const encryptedSafe = this.state.settings.e2e && !options.plaintextE2e;
    const docs = encryptedSafe ? await this.db.getAll('docs') : this.state.docs;
    const payload = {
      settings: this.validateSettings(this.state.settings),
      folders: this.validateFolders(this.state.folders),
      docs: docs.map((doc) => doc.encrypted ? structuredClone(doc) : this.sanitizeDoc(structuredClone(doc))),
      lore: structuredClone(this.state.lore),
      globalNotes: encryptedSafe ? '' : this.state.globalNotes,
      floatingNotes: encryptedSafe ? [] : this.state.floatingNotes.map((note) => this.sanitizeFloatingNote(note)),
      typoRules: this.state.typoRules.map((rule) => this.sanitizeTypoRule(rule)).filter(Boolean),
      reviewMarks: this.state.reviewMarks.map((mark) => this.sanitizeReviewMark(mark)).filter(Boolean),
      snapshots: encryptedSafe ? [] : await this.db.getAll('snapshots'),
      stats: await this.db.getAll('stats'),
      exportSettings: { exportNocturned: this.state.exportNocturned },
    };
    const withoutChecksum = {
      format: 'nocturnedump',
      version: 1,
      appName: 'Nocturne Writer',
      appVersion: '1.0.0',
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      encrypted: !!this.state.settings.e2e,
      plaintextE2e: !!options.plaintextE2e,
      payload,
    };
    const checksum = await this.checksumText(JSON.stringify(withoutChecksum.payload));
    return { ...withoutChecksum, checksum };
  }

  async openProjectExportModal() {
    const overlay = document.getElementById('form-overlay');
    const e2eWarning = this.state.settings.e2e
      ? '<p class="form-helper warning-text">E2E включено. Безопасный экспорт сохраняет зашифрованные данные и не добавляет открытые заметки/снапшоты. Plaintext-экспорт доступен только после явного подтверждения.</p>'
      : '<p class="form-helper">Dump сохранит документы, базу знаний, настройки, заметки, правки, словарь и снапшоты.</p>';
    overlay.innerHTML = `
      <div class="form-modal project-dump-modal">
        <div class="modal-head-row">
          <div><h2>Экспорт проекта</h2><p>.nocturnedump резервная копия всего проекта.</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        ${e2eWarning}
        <div class="dump-summary-grid">
          <span><strong>${this.state.docs.length}</strong> документов</span>
          <span><strong>${this.state.lore.characters.length}</strong> персонажей</span>
          <span><strong>${this.state.lore.locations.length}</strong> локаций</span>
          <span><strong>${this.state.lore.timeline.length}</strong> событий</span>
        </div>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn ai-btn" data-action="confirm-export-project-dump"><i class="bx bx-archive-out"></i> Экспорт безопасного dump</button>
          ${this.state.settings.e2e ? '<button class="pill-btn danger-btn" data-action="confirm-export-project-dump-plaintext">Экспорт plaintext</button>' : ''}
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelectorAll('[data-close-form]').forEach((button) => { button.onclick = () => overlay.classList.remove('active'); });
  }

  async animateProjectExport(dump) {
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx bx-cloud-upload"></i>
        </div>
        <h3>Экспортируем проект...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    
    overlay.classList.add('active');
    await new Promise(r => setTimeout(r, 600));
    
    const listEl = overlay.querySelector('.kb-import-progress-list');
    const payload = dump.payload || {};
    const lore = payload.lore || {};
    
    const categories = [];
    if (payload.folders?.length > 0) categories.push({ label: 'Папки', count: payload.folders.length });
    if (payload.docs?.length > 0) categories.push({ label: 'Документы', count: payload.docs.length });
    if (lore.characters?.length > 0) categories.push({ label: 'Персонажи', count: lore.characters.length });
    if (lore.locations?.length > 0) categories.push({ label: 'Локации', count: lore.locations.length });
    if (lore.timeline?.length > 0) categories.push({ label: 'Таймлайн', count: lore.timeline.length });
    if (payload.floatingNotes?.length > 0 || payload.globalNotes) {
      const count = (payload.floatingNotes?.length || 0) + (payload.globalNotes ? 1 : 0);
      categories.push({ label: 'Записи', count });
    }
    
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${i * 150}ms`;
      step.innerHTML = `<span>Упаковано: ${cat.label} (${cat.count})</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    await new Promise(r => setTimeout(r, 1000));
    overlay.classList.remove('active');
  }

  findTelegramArtifacts(text) {
    const matches = [];
    const pcRegex = /(^|\r?\n)(\[\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\]\s+([^:\n\s][a-zA-Z0-9_а-яА-ЯёЁ\s\-]{1,30}):\s*)/g;
    const mobileRegex = /(^|\r?\n)(([^:\n\s\.\?!,][a-zA-Z0-9_а-яА-ЯёЁ\s\-]{1,30}):\s*)(?=\r?\n)/g;
    
    let match;
    pcRegex.lastIndex = 0;
    while ((match = pcRegex.exec(text)) !== null) {
      matches.push({
        type: 'pc',
        raw: match[2],
        index: match.index
      });
    }
    
    mobileRegex.lastIndex = 0;
    while ((match = mobileRegex.exec(text)) !== null) {
      matches.push({
        type: 'mobile',
        raw: match[2],
        index: match.index
      });
    }
    
    return matches;
  }

  cleanTelegramArtifacts(text) {
    let cleaned = text.replace(/(^|\r?\n)\[\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}\]\s+([^:\n\s][a-zA-Z0-9_а-яА-ЯёЁ\s\-]{1,30}):\s*/g, (match, p1) => {
      return p1;
    });
    
    cleaned = cleaned.replace(/(^|\r?\n)([^:\n\s\.\?!,][a-zA-Z0-9_а-яА-ЯёЁ\s\-]{1,30}):\s*(?=\r?\n)/g, (match, p1) => {
      return p1;
    });
    
    return cleaned;
  }

  setReaperImage(imgEl, stateName) {
    const src = `/reaper_photo/reaper_${stateName}.png`;
    imgEl.src = src;
    const wrapper = imgEl.closest('.cleaner-reaper-wrapper');
    if (wrapper) {
      const tint = wrapper.querySelector('.cleaner-reaper-tint');
      if (tint) {
        tint.style.webkitMaskImage = `url(${src})`;
        tint.style.maskImage = `url(${src})`;
      }
    }
  }

  updateModalContent(contentEl, newHtml) {
    const modal = contentEl.closest('.cleaner-modal');
    if (!modal) {
      contentEl.innerHTML = newHtml;
      return;
    }
    
    const prevHeight = modal.offsetHeight;
    modal.style.height = `${prevHeight}px`;
    
    contentEl.innerHTML = newHtml;
    
    modal.style.height = '';
    const targetHeight = modal.offsetHeight;
    
    modal.style.height = `${prevHeight}px`;
    
    requestAnimationFrame(() => {
      modal.style.transition = 'height 300ms cubic-bezier(0.16, 1, 0.3, 1)';
      modal.style.height = `${targetHeight}px`;
      
      setTimeout(() => {
        modal.style.height = '';
        modal.style.transition = '';
      }, 300);
    });
  }

  async transitionReaperImage(imgEl, nextState, options = {}) {
    const { duration = 250 } = options;
    const wrapper = imgEl.closest('.cleaner-reaper-wrapper');
    const tint = wrapper ? wrapper.querySelector('.cleaner-reaper-tint') : null;
    const glowImg = wrapper ? wrapper.querySelector('#cleaner-reaper-glow-img') : null;
    const glowTint = wrapper ? wrapper.querySelector('.cleaner-reaper-glow-tint') : null;
    
    if (nextState === 'found') {
      if (glowImg && glowTint) {
        glowImg.src = '/reaper_photo/reaper_found.png';
        glowTint.style.webkitMaskImage = 'url(/reaper_photo/reaper_found.png)';
        glowTint.style.maskImage = 'url(/reaper_photo/reaper_found.png)';
        glowImg.style.transition = `opacity ${duration}ms ease`;
        glowTint.style.transition = `opacity ${duration}ms ease`;
        glowImg.style.opacity = '1';
        glowTint.style.opacity = '1';
        await new Promise(r => setTimeout(r, duration));
        return;
      }
    }
    
    if (glowImg && glowTint) {
      const src = `/reaper_photo/reaper_${nextState}.png`;
      glowImg.src = src;
      glowTint.style.webkitMaskImage = `url(${src})`;
      glowTint.style.maskImage = `url(${src})`;
      
      // Coordinated cross-fade: fade base layer out while fading overlay layer in
      imgEl.style.transition = `opacity ${duration}ms ease`;
      if (tint) tint.style.transition = `opacity ${duration}ms ease`;
      glowImg.style.transition = `opacity ${duration}ms ease`;
      glowTint.style.transition = `opacity ${duration}ms ease`;
      
      imgEl.style.opacity = '0';
      if (tint) tint.style.opacity = '0';
      glowImg.style.opacity = '1';
      glowTint.style.opacity = '1';
      
      await new Promise(r => setTimeout(r, duration));
      
      this.setReaperImage(imgEl, nextState);
      
      imgEl.style.transition = 'none';
      if (tint) tint.style.transition = 'none';
      imgEl.style.opacity = '1';
      if (tint) tint.style.opacity = '1';
      
      glowImg.style.transition = 'none';
      glowTint.style.transition = 'none';
      glowImg.style.opacity = '0';
      glowTint.style.opacity = '0';
      glowImg.offsetHeight; // force reflow
      return;
    }
    
    this.setReaperImage(imgEl, nextState);
  }

  async transitionReaperToDelete(imgEl) {
    const wrapper = imgEl.closest('.cleaner-reaper-wrapper');
    const tint = wrapper ? wrapper.querySelector('.cleaner-reaper-tint') : null;
    const glowImg = wrapper ? wrapper.querySelector('#cleaner-reaper-glow-img') : null;
    const glowTint = wrapper ? wrapper.querySelector('.cleaner-reaper-glow-tint') : null;
    
    if (wrapper) {
      wrapper.classList.remove('floating');
      wrapper.classList.add('shaking');
    }
    
    if (glowImg && glowTint) {
      const src = '/reaper_photo/reaper_delete.png';
      glowImg.src = src;
      glowTint.style.webkitMaskImage = `url(${src})`;
      glowTint.style.maskImage = `url(${src})`;
      
      imgEl.style.transition = 'opacity 150ms ease';
      if (tint) tint.style.transition = 'opacity 150ms ease';
      glowImg.style.transition = 'opacity 150ms ease';
      glowTint.style.transition = 'opacity 150ms ease';
      
      imgEl.style.opacity = '0';
      if (tint) tint.style.opacity = '0';
      glowImg.style.opacity = '1';
      glowTint.style.opacity = '1';
      
      await new Promise(r => setTimeout(r, 150));
      
      this.setReaperImage(imgEl, 'delete');
      imgEl.style.transition = 'none';
      if (tint) tint.style.transition = 'none';
      imgEl.style.opacity = '1';
      if (tint) tint.style.opacity = '1';
      
      glowImg.style.transition = 'none';
      glowTint.style.transition = 'none';
      glowImg.style.opacity = '0';
      glowTint.style.opacity = '0';
      glowImg.offsetHeight;
    } else {
      this.setReaperImage(imgEl, 'delete');
    }
    
    await new Promise(r => setTimeout(r, 550));
    if (wrapper) {
      wrapper.classList.remove('shaking');
      wrapper.classList.add('floating');
    }
  }

  openCleanerModal(noteId = null) {
    let overlay = document.getElementById('cleaner-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cleaner-overlay';
      overlay.className = 'cleaner-overlay';
      document.body.appendChild(overlay);
    }
    
    overlay.innerHTML = `
      <div class="cleaner-modal-container">
        <div class="cleaner-reaper-wrapper">
          <!-- Base layers -->
          <img src="/reaper_photo/reaper_start.png" id="cleaner-reaper-img" class="cleaner-reaper-img" alt="Reaper">
          <div class="cleaner-reaper-tint" style="-webkit-mask-image: url(/reaper_photo/reaper_start.png); mask-image: url(/reaper_photo/reaper_start.png);"></div>
          
          <!-- Glow overlay (reaper_found.png) -->
          <img src="/reaper_photo/reaper_found.png" id="cleaner-reaper-glow-img" class="cleaner-reaper-img" style="opacity: 0; z-index: 10;" alt="Reaper Glow">
          <div class="cleaner-reaper-glow-tint" style="-webkit-mask-image: url(/reaper_photo/reaper_found.png); mask-image: url(/reaper_photo/reaper_found.png); opacity: 0; z-index: 11;"></div>
        </div>
        <div class="cleaner-modal">
          <div class="cleaner-content" id="cleaner-content">
            <h2>«Чистильщик™»</h2>
            <p>Интеллектуальный помощник для удаления артефактов Telegram (авторских заголовков, дат и ников) из текстов заметок.</p>
            <div class="form-actions" style="justify-content: center; gap: 12px; margin-top: 24px;">
              <button class="pill-btn danger-btn" data-action="close-cleaner" style="min-width: 100px;">Отмена</button>
              <button class="pill-btn ai-btn" id="start-scan-btn" style="min-width: 160px;"><i class="bx bx-search-alt"></i> Запустить поиск</button>
            </div>
          </div>
        </div>
      </div>
    `;
    
    overlay.classList.add('active');
    
    const reaperImg = overlay.querySelector('#cleaner-reaper-img');
    const reaperTint = overlay.querySelector('.cleaner-reaper-tint');
    const reaperWrapper = overlay.querySelector('.cleaner-reaper-wrapper');
    
    [reaperImg, reaperTint].forEach(el => {
      if (!el) return;
      el.style.opacity = '0';
      el.style.transform = 'translateY(20px)';
    });
    setTimeout(() => {
      [reaperImg, reaperTint].forEach(el => {
        if (!el) return;
        el.style.transition = 'opacity 500ms ease, transform 500ms ease';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
      setTimeout(() => {
        if (reaperWrapper) reaperWrapper.classList.add('floating');
      }, 500);
    }, 200);

    overlay.querySelector('[data-action="close-cleaner"]').onclick = () => {
      overlay.classList.remove('active');
    };

    overlay.querySelector('#start-scan-btn').onclick = async () => {
      const contentEl = overlay.querySelector('#cleaner-content');
      this.updateModalContent(contentEl, `
        <h2>Сканирование...</h2>
        <p>Ищем остатки переписок из Telegram (ПК и мобильной версии)...</p>
        <div class="kb-import-spinner" style="margin-bottom: 20px;">
          <div class="spinner-ring"></div>
          <i class="bx bx-scan" style="animation: pulse 1s infinite alternate;"></i>
        </div>
        <div class="cleaner-progress-text" style="font-size: 11px; color: var(--text-muted);">Инициализация...</div>
      `);
      
      const progressText = contentEl.querySelector('.cleaner-progress-text');
      
      await new Promise(r => setTimeout(r, 600));
      progressText.textContent = noteId ? 'Анализ текста выбранной заметки...' : 'Загрузка списка всех заметок...';
      
      await new Promise(r => setTimeout(r, 650));
      progressText.textContent = 'Поиск ПК-версий логов Telegram...';
      
      await new Promise(r => setTimeout(r, 650));
      progressText.textContent = 'Поиск мобильных версий логов Telegram...';
      
      let matches = [];
      let totalNotesScanned = 0;
      if (noteId) {
        const note = this.state.lore.notes.find(n => n.id === noteId);
        if (note) {
          matches = this.findTelegramArtifacts(note.body || '');
          totalNotesScanned = 1;
        }
      } else {
        const notes = this.state.lore.notes || [];
        notes.forEach(note => {
          const noteMatches = this.findTelegramArtifacts(note.body || '');
          if (noteMatches.length) {
            matches.push(...noteMatches.map(m => ({ ...m, noteId: note.id, noteTitle: note.title })));
          }
        });
        totalNotesScanned = notes.length;
      }
      
      if (matches.length === 0) {
        this.showCleanerMatchesState(overlay, matches, noteId, totalNotesScanned);
      } else {
        await this.transitionReaperImage(reaperImg, 'found', { blur: false });
        this.showCleanerMatchesState(overlay, matches, noteId, totalNotesScanned);
      }
    };
  }

  showCleanerMatchesState(overlay, matches, noteId, totalNotesScanned) {
    const contentEl = overlay.querySelector('#cleaner-content');
    const reaperImg = overlay.querySelector('#cleaner-reaper-img');
    
    if (matches.length === 0) {
      this.transitionReaperImage(reaperImg, 'success', { duration: 250 }).then(() => {
        this.updateModalContent(contentEl, `
          <h2>Текст чист, мастер</h2>
          <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6; margin-bottom: 24px;">
            ${noteId ? 'В выбранной заметке' : `В проверенных заметках (${totalNotesScanned})`} не обнаружено артефактов копирования Telegram.
          </p>
          <div class="form-actions" style="justify-content: center; margin-top: 24px;">
            <button class="pill-btn ai-btn" data-action="close-cleaner" style="min-width: 120px;">Закрыть</button>
          </div>
        `);
        overlay.querySelector('[data-action="close-cleaner"]').onclick = () => {
          overlay.classList.remove('active');
        };
      });
      return;
    }
    
    const matchesHtml = matches.map(m => {
      const badge = m.type === 'pc' ? '<span class="cleaner-match-badge pc">ПК</span>' : '<span class="cleaner-match-badge mobile">Моб</span>';
      const noteTitle = m.noteTitle ? `<span style="color: var(--accent); font-weight: bold;">[${escapeHtml(m.noteTitle)}]</span> ` : '';
      return `<div class="cleaner-match-item">
        ${badge} ${noteTitle} <span class="cleaner-match-text">${escapeHtml(m.raw.trim())}</span>
      </div>`;
    }).join('');
    
    this.updateModalContent(contentEl, `
      <h2>Найденные совпадения</h2>
      <p>«Чистильщик™» обнаружил <strong>${matches.length}</strong> совпадений в тексте. Посмотрите список ниже перед удалением.</p>
      
      <div class="cleaner-matches-container">
        ${matchesHtml}
      </div>
      
      <div class="form-actions" style="flex-direction: column; gap: 12px; margin-top: 20px;">
        <button class="cut-btn-nocturne" id="cut-btn"><i class="bx bx-cut"></i> ВЫРЕЗАТЬ</button>
        <button class="pill-btn danger-btn" data-action="close-cleaner" style="width: 100%;">Отмена</button>
      </div>
    `);
    
    overlay.querySelector('[data-action="close-cleaner"]').onclick = () => {
      overlay.classList.remove('active');
    };
    
    overlay.querySelector('#cut-btn').onclick = async () => {
      await this.transitionReaperToDelete(reaperImg);
      
      this.updateModalContent(contentEl, `
        <h2>Очистка текста...</h2>
        <p>«Чистильщик™» вырезает метаданные и форматирует строки...</p>
        <div class="kb-import-spinner" style="margin-bottom: 20px;">
          <div class="spinner-ring"></div>
          <i class="bx bx-eraser" style="animation: pulse 1s infinite alternate;"></i>
        </div>
        <div class="cleaner-progress-text" style="font-size: 11px; color: var(--text-muted);">Инициализация очистки...</div>
      `);
      
      const progressText = contentEl.querySelector('.cleaner-progress-text');
      
      await new Promise(r => setTimeout(r, 700));
      progressText.textContent = 'Удаление временных меток и юзернеймов...';
      
      let errorOccurred = false;
      try {
        if (noteId) {
          const noteIndex = this.state.lore.notes.findIndex(n => n.id === noteId);
          if (noteIndex !== -1) {
            const note = this.state.lore.notes[noteIndex];
            note.body = this.cleanTelegramArtifacts(note.body || '');
            note.updatedAt = Date.now();
            await this.saveLore();
          }
        } else {
          const notes = this.state.lore.notes || [];
          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];
            note.body = this.cleanTelegramArtifacts(note.body || '');
            note.updatedAt = Date.now();
          }
          await this.saveLore();
        }
      } catch (err) {
        console.error('Cleaner error:', err);
        errorOccurred = true;
      }
      
      await new Promise(r => setTimeout(r, 700));
      progressText.textContent = 'Восстановление абзацев и отступов...';
      
      await new Promise(r => setTimeout(r, 700));
      progressText.textContent = 'Запись изменений в базу данных...';
      
      await new Promise(r => setTimeout(r, 500));
      
      if (errorOccurred) {
        await this.transitionReaperImage(reaperImg, 'error', { duration: 250 });
        this.updateModalContent(contentEl, `
          <h2>Произошла ошибка</h2>
          <p>«Чистильщик™» столкнулся с непредвиденной ошибкой при изменении базы данных.</p>
          <div class="form-actions" style="justify-content: center; margin-top: 24px;">
            <button class="pill-btn danger-btn" data-action="close-cleaner" style="min-width: 120px;">Закрыть</button>
          </div>
        `);
        overlay.querySelector('[data-action="close-cleaner"]').onclick = () => {
          overlay.classList.remove('active');
        };
      } else {
        await this.transitionReaperImage(reaperImg, 'success', { duration: 250 });
        
        this.updateModalContent(contentEl, `
          <h2>Очистка завершена, мастер</h2>
          <p style="color: var(--text-muted); font-size: 13px; line-height: 1.6; margin-bottom: 24px;">
            Все артефакты копирования сообщений Telegram были успешно удалены из заметок.
          </p>
          <div class="form-actions" style="justify-content: center; margin-top: 24px;">
            <button class="pill-btn ai-btn" id="close-success-btn" style="min-width: 120px;">Закрыть</button>
          </div>
        `);
        
        overlay.querySelector('#close-success-btn').onclick = () => {
          overlay.classList.remove('active');
          this.renderKb();
          this.renderNotes();
        };
      }
    };
  }

  async exportProjectDump(options = {}) {
    const dump = await this.buildNocturneDump(options);
    const data = JSON.stringify(dump, null, 2);
    const name = `nocturne-${new Date().toISOString().slice(0, 10)}.nocturnedump`;
    await this.animateProjectExport(dump);
    await platformFiles.exportProjectDump(data, { suggestedName: name });
    this.toast('Dump проекта экспортирован.');
    return dump;
  }

  async startProjectDumpImport() {
    try {
      const file = await platformFiles.importProjectDump();
      if (!file?.data) return;
      await this.handleProjectDumpText(file.data, file.name || 'project.nocturnedump');
    } catch (error) {
      this.toast(error?.message || 'Не удалось открыть dump.');
    }
  }

  validateProjectDump(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Dump не является JSON-объектом.');
    if (raw.format !== 'nocturnedump') throw new Error('Это не .nocturnedump файл.');
    if (!raw.payload || typeof raw.payload !== 'object') throw new Error('Dump не содержит payload.');
    const payload = raw.payload;
    ['folders', 'docs', 'typoRules', 'reviewMarks', 'snapshots'].forEach((key) => {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) throw new Error(`Некорректный раздел ${key}.`);
    });
    if (payload.lore && typeof payload.lore !== 'object') throw new Error('Некорректный раздел lore.');
    return raw;
  }

  async handleProjectDumpText(text, filename = 'project.nocturnedump') {
    if (String(text || '').length > 80 * 1024 * 1024) {
      this.toast('Dump слишком большой для безопасного импорта.');
      return;
    }
    let dump;
    try {
      dump = this.validateProjectDump(JSON.parse(text));
    } catch (error) {
      this.openImportErrorModal(error.message || 'Не удалось прочитать dump.', filename);
      return;
    }
    this.openProjectImportPreview(dump, filename);
  }

  dumpPreviewStats(dump) {
    const payload = dump.payload || {};
    const lore = payload.lore || {};
    return {
      docs: payload.docs?.length || 0,
      characters: lore.characters?.length || 0,
      locations: lore.locations?.length || 0,
      timeline: lore.timeline?.length || 0,
      subtimelines: (lore.timeline || []).reduce((sum, item) => sum + (item.subEvents?.length || 0), 0),
      snapshots: payload.snapshots?.length || 0,
      floatingNotes: payload.floatingNotes?.length || 0,
    };
  }

  openImportErrorModal(message, filename) {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-error-circle"></i></div>
        <h2>Dump не импортирован</h2>
        <p>${escapeHtml(filename)}: ${escapeHtml(message)}</p>
        <div class="form-actions"><button class="pill-btn ai-btn" data-close-form>Закрыть</button></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  openProjectImportPreview(dump, filename) {
    const stats = this.dumpPreviewStats(dump);
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal project-dump-modal">
        <div class="modal-head-row">
          <div><h2>Предпросмотр импорта</h2><p>${escapeHtml(filename)} · схема ${escapeHtml(dump.schemaVersion || 'неизвестно')}</p></div>
          <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>
        </div>
        <div class="dump-summary-grid">
          <span><strong>${stats.docs}</strong> документов</span>
          <span><strong>${stats.characters}</strong> персонажей</span>
          <span><strong>${stats.locations}</strong> локаций</span>
          <span><strong>${stats.timeline}</strong> событий</span>
          <span><strong>${stats.subtimelines}</strong> подсобытий</span>
          <span><strong>${stats.snapshots}</strong> снапшотов</span>
        </div>
        <p class="form-helper">Экспортирован: ${escapeHtml(dump.exportedAt || 'неизвестно')} · checksum: ${escapeHtml(String(dump.checksum || '').slice(0, 16) || 'нет')}</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn" data-action="merge-project-dump">Объединить с текущим</button>
          <button class="pill-btn danger-btn" data-action="replace-project-dump">Заменить текущий проект</button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelectorAll('[data-close-form]').forEach((button) => { button.onclick = () => overlay.classList.remove('active'); });
    overlay.querySelector('[data-action="merge-project-dump"]').onclick = async () => {
      const report = await this.importProjectDump(dump, { mode: 'merge' });
      overlay.classList.remove('active');
      this.openImportReport(report);
    };
    overlay.querySelector('[data-action="replace-project-dump"]').onclick = async () => {
      const confirmed = await this.confirmDialog({
        title: 'Заменить текущий проект?',
        message: 'Перед заменой можно скачать резервную копию текущего проекта. Замена удалит текущие локальные данные и загрузит dump.',
        confirmText: 'Заменить',
        icon: 'bx-error',
      });
      if (!confirmed) return;
      await this.exportProjectDump({ backupBeforeReplace: true });
      const report = await this.importProjectDump(dump, { mode: 'replace' });
      overlay.classList.remove('active');
      this.openImportReport(report);
    };
  }

  async animateProjectImportProgress(dump, mode) {
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx bx-cloud-download"></i>
        </div>
        <h3>Импортируем проект...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    overlay.classList.add('active');
    await new Promise(r => setTimeout(r, 600));
    
    const listEl = overlay.querySelector('.kb-import-progress-list');
    const steps = [];
    if (mode === 'replace') {
      steps.push('Очистка текущей базы...');
    }
    steps.push('Импорт настроек и папок...');
    steps.push('Импорт документов...');
    steps.push('Импорт базы знаний...');
    steps.push('Импорт снапшотов и заметок...');
    steps.push('Импорт завершен!');
    
    for (let i = 0; i < steps.length; i++) {
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${i * 150}ms`;
      step.innerHTML = `<span>${steps[i]}</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 350));
    }
    
    await new Promise(r => setTimeout(r, 800));
    overlay.classList.remove('active');
  }

  async importProjectDump(dump, { mode = 'merge' } = {}) {
    const payload = dump.payload || {};
    const report = { mode, docs: 0, folders: 0, characters: 0, locations: 0, timeline: 0, snapshots: 0, reviewMarks: 0, conflicts: 0 };
    await this.animateProjectImportProgress(dump, mode);
    if (mode === 'replace') {
      await Promise.all(['settings', 'folders', 'docs', 'lore', 'snapshots', 'stats', 'floatingNotes', 'typoRules', 'reviewMarks'].map((store) => this.db.clear(store)));
      this.state.settings = this.validateSettings(payload.settings || {});
      this.state.folders = this.validateFolders(payload.folders || []);
      this.state.docs = (payload.docs || []).map((doc) => this.sanitizeDoc(structuredClone(doc)));
      this.state.lore = {
        characters: (payload.lore?.characters || []).map((item, index) => this.normalizeCharacter(item, index)),
        locations: (payload.lore?.locations || []).map((item, index) => this.normalizeLocation(item, index)),
        timeline: (payload.lore?.timeline || []).map((item, index) => this.normalizeTimelineEvent(item, index)),
        notes: (payload.lore?.notes || []).map((item, index) => this.normalizeNote(item, index)),
      };
      this.state.globalNotes = String(payload.globalNotes || '');
      this.state.floatingNotes = (payload.floatingNotes || []).map((note) => this.sanitizeFloatingNote(note));
      this.state.typoRules = (payload.typoRules || []).map((rule) => this.sanitizeTypoRule(rule)).filter(Boolean);
      this.state.reviewMarks = (payload.reviewMarks || []).map((mark) => this.sanitizeReviewMark(mark)).filter(Boolean);
      await this.persistImportedProject(payload);
      Object.assign(report, this.dumpPreviewStats(dump), { folders: this.state.folders.length, reviewMarks: this.state.reviewMarks.length });
    } else {
      await this.mergeProjectDumpPayload(payload, report);
    }
    this.validateLoadedState();
    this.initWorkspace();
    this.applySettings();
    this.renderAll();
    this.toast(mode === 'replace' ? 'Проект заменён из dump.' : 'Dump проекта объединён.');
    return report;
  }

  async persistImportedProject(payload = {}) {
    await this.db.put('settings', { id: 'app', value: this.state.settings });
    await Promise.all(this.state.folders.map((item) => this.db.put('folders', item)));
    await Promise.all(this.state.docs.map((item) => this.db.put('docs', item)));
    await this.db.put('lore', { id: 'world', ...this.state.lore });
    await Promise.all(this.state.floatingNotes.map((item) => this.db.put('floatingNotes', item)));
    await Promise.all(this.state.typoRules.map((item) => this.db.put('typoRules', item)));
    await Promise.all(this.state.reviewMarks.map((item) => this.db.put('reviewMarks', item)));
    await Promise.all((payload.snapshots || []).map((item) => this.db.put('snapshots', item)));
    await Promise.all((payload.stats || []).map((item) => this.db.put('stats', item)));
  }

  remapId(id, map, prefix, existingIds, report) {
    if (!id) return id;
    if (map.has(id)) return map.get(id);
    const next = existingIds.has(id) ? uid(prefix) : id;
    if (next !== id) report.conflicts += 1;
    existingIds.add(next);
    map.set(id, next);
    return next;
  }

  async mergeProjectDumpPayload(payload, report) {
    const idMap = new Map();
    const existingFolders = new Set(this.state.folders.map((item) => item.id));
    const existingDocs = new Set(this.state.docs.map((item) => item.id));
    const existingCharacters = new Set(this.state.lore.characters.map((item) => item.id));
    const existingLocations = new Set(this.state.lore.locations.map((item) => item.id));
    const existingTimeline = new Set(this.state.lore.timeline.map((item) => item.id));

    const existingNotes = new Set((this.state.lore.notes || []).map((item) => item.id));

    const folders = (payload.folders || []).map((folder, index) => {
      const next = { ...folder, id: this.remapId(folder.id, idMap, 'folder', existingFolders, report), order: this.state.folders.length + index };
      return next;
    });
    const docs = (payload.docs || []).map((doc, index) => {
      const next = structuredClone(doc);
      next.id = this.remapId(doc.id, idMap, 'doc', existingDocs, report);
      next.folderId = idMap.get(doc.folderId) || this.defaultFolderId();
      next.order = this.state.docs.length + index;
      return this.sanitizeDoc(next);
    });
    const chars = (payload.lore?.characters || []).map((item, index) => this.normalizeCharacter({ ...item, id: this.remapId(item.id, idMap, 'char', existingCharacters, report), documentIds: (item.documentIds || []).map((id) => idMap.get(id) || id) }, this.state.lore.characters.length + index));
    const locs = (payload.lore?.locations || []).map((item, index) => this.normalizeLocation({ ...item, id: this.remapId(item.id, idMap, 'loc', existingLocations, report), documentIds: (item.documentIds || []).map((id) => idMap.get(id) || id) }, this.state.lore.locations.length + index));
    const times = (payload.lore?.timeline || []).map((item, index) => {
      const next = structuredClone(item);
      next.id = this.remapId(item.id, idMap, 'time', existingTimeline, report);
      next.documentIds = (item.documentIds || []).map((id) => idMap.get(id) || id);
      next.subEvents = (item.subEvents || []).map((sub) => ({ ...sub, id: uid('subtime'), documentIds: (sub.documentIds || []).map((id) => idMap.get(id) || id) }));
      return this.normalizeTimelineEvent(next, this.state.lore.timeline.length + index);
    });
    const notesLore = (payload.lore?.notes || []).map((item, index) => this.normalizeNote({ ...item, id: this.remapId(item.id, idMap, 'note', existingNotes, report) }, (this.state.lore.notes || []).length + index));

    this.state.folders.push(...folders);
    this.state.docs.push(...docs);
    this.state.lore.characters.push(...chars);
    this.state.lore.locations.push(...locs);
    this.state.lore.timeline.push(...times);
    if (!this.state.lore.notes) this.state.lore.notes = [];
    this.state.lore.notes.push(...notesLore);

    const notes = (payload.floatingNotes || []).map((note) => this.sanitizeFloatingNote({ ...note, id: uid('note'), linkedId: idMap.get(note.linkedId) || note.linkedId }));
    const typoRules = (payload.typoRules || []).map((rule) => this.sanitizeTypoRule({ ...rule, id: uid('typo-rule') })).filter(Boolean);
    const marks = (payload.reviewMarks || []).map((mark) => this.sanitizeReviewMark({ ...mark, id: uid('review'), docId: idMap.get(mark.docId) || mark.docId })).filter(Boolean);
    this.state.floatingNotes.push(...notes);
    this.state.typoRules.push(...typoRules);
    this.state.reviewMarks.push(...marks);
    await Promise.all([...folders.map((item) => this.db.put('folders', item)), ...docs.map((item) => this.db.put('docs', item))]);
    await this.saveLore();
    await Promise.all([...notes.map((item) => this.db.put('floatingNotes', item)), ...typoRules.map((item) => this.db.put('typoRules', item)), ...marks.map((item) => this.db.put('reviewMarks', item))]);
    await Promise.all((payload.snapshots || []).map((snap) => this.db.put('snapshots', { ...snap, id: uid('snap'), docId: idMap.get(snap.docId) || snap.docId })));
    Object.assign(report, { folders: folders.length, docs: docs.length, characters: chars.length, locations: locs.length, timeline: times.length, notes: notesLore.length, snapshots: payload.snapshots?.length || 0, reviewMarks: marks.length });
  }

  openImportReport(report) {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal project-dump-modal">
        <div class="confirm-icon"><i class="bx bx-check-circle"></i></div>
        <h2>Отчёт импорта</h2>
        <div class="dump-summary-grid">
          <span><strong>${report.docs}</strong> документов</span>
          <span><strong>${report.characters}</strong> персонажей</span>
          <span><strong>${report.locations}</strong> локаций</span>
          <span><strong>${report.timeline}</strong> событий</span>
          <span><strong>${report.notes || 0}</strong> записей</span>
          <span><strong>${report.snapshots}</strong> снапшотов</span>
          <span><strong>${report.conflicts}</strong> конфликтов ID</span>
        </div>
        <div class="form-actions"><button class="pill-btn ai-btn" data-close-form>Закрыть</button></div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
  }

  exportPrintable() {
    const doc = this.activeDoc;
    if (!doc) {
      this.toast('Откройте документ для экспорта.');
      return;
    }
    const watermark = this.state.settings.watermark ? `${escapeHtml(this.state.settings.authorName)} · ${new Date().toLocaleDateString()}` : '';
    const pages = this.paginate(doc.ast).map((page, index) => `<section class="print-page">${watermark ? `<div class="watermark"><span>${watermark}</span></div>` : ''}${this.renderBlocks(page.blocks)}<footer>${index + 1}</footer></section>`).join('');
    const win = window.open('', '_blank');
    if (!win) {
      this.toast('Браузер заблокировал окно экспорта. Разрешите всплывающие окна и повторите.');
      return;
    }
    win.document.write(`<!doctype html><html><head><title>${escapeHtml(doc.title)}</title><style>
      body{margin:0;background:#ddd;font:18px/1.75 Georgia,serif;color:#111}.print-page{position:relative;width:794px;min-height:1123px;margin:24px auto;background:white;padding:96px;box-sizing:border-box;page-break-after:always}.print-page h2{font-size:28px}.print-page footer{position:absolute;bottom:36px;left:0;right:0;text-align:center;color:#777}.watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:1000;pointer-events:none;overflow:hidden}.watermark span{transform:rotate(-45deg);font:700 56px sans-serif;color:rgba(0,0,0,0.05);white-space:nowrap;user-select:none;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{body{background:white}.print-page{margin:0;box-shadow:none}}
    </style></head><body>${pages}<script>setTimeout(()=>print(),300)</script></body></html>`);
    win.document.close();
  }

  exportDocx() {
    const doc = this.activeDoc;
    if (!doc) {
      this.toast('Откройте документ для экспорта.');
      return;
    }
    const paragraphs = (doc.ast.blocks || []).map((block) => {
      const runs = this.docxRunsFromHtml(block.html || '');
      const align = block.align && block.align !== 'left' ? `<w:jc w:val="${block.align === 'center' ? 'center' : block.align === 'right' ? 'right' : 'both'}"/>` : '';
      if (block.type === 'heading') {
        return `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${align}</w:pPr>${runs}</w:p>`;
      }
      const style = block.type === 'quote' ? '<w:pStyle w:val="Quote"/>' : '';
      return `<w:p><w:pPr>${style}<w:spacing w:after="180" w:line="360" w:lineRule="auto"/>${align}</w:pPr>${runs}</w:p>`;
    }).join('');
    const notes = [doc.description, doc.notes, this.state.globalNotes].filter(Boolean).map((note, index) => (
      `<w:p><w:pPr><w:pStyle w:val="${index === 0 ? 'Subtitle' : 'Quote'}"/></w:pPr><w:r><w:t>${this.xmlEscape(note)}</w:t></w:r></w:p>`
    )).join('');
    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
      'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${this.xmlEscape(doc.title)}</dc:title><dc:creator>${this.xmlEscape(this.state.settings.authorName || 'Nocturne')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style></w:styles>`,
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${notes}${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
    };
    const blob = new Blob([this.createZip(files)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    this.downloadBlob(blob, `${this.safeFileName(doc.title)}.docx`);
    const marks = this.state.reviewMarks.filter((mark) => mark.docId === doc.id);
    if (marks.length && this.state.exportNocturned) {
      const reviewBlob = new Blob([JSON.stringify(this.buildNocturnedPayload(doc, marks), null, 2)], { type: 'application/json' });
      setTimeout(() => this.downloadBlob(reviewBlob, `${this.safeFileName(doc.title)}.nocturned`), 120);
      this.toast('DOCX и файл редакторских правок экспортированы.');
    } else if (this.state.exportNocturned) {
      this.toast('DOCX экспортирован. Файл правок .nocturned не скачан, так как в документе нет правок.');
    } else {
      this.toast('DOCX экспортирован.');
    }
  }

  buildNocturnedPayload(doc, marks) {
    const blocks = doc.ast?.blocks || [];
    return {
      format: 'nocturne-review-delta',
      version: 1,
      exportedAt: Date.now(),
      document: {
        sourceDocId: doc.id,
        title: doc.title,
        normalizedTextHash: this.documentPortableHash(doc),
        blockCount: blocks.length,
        blocks: blocks.map((block, index) => ({
          index,
          type: block.type || 'paragraph',
          textHash: this.textHash(blockText(block)),
          plainText: blockText(block),
        })),
      },
      reviewMarks: marks.map((mark) => this.reviewMarkToNocturned(mark, doc)),
    };
  }

  reviewMarkToNocturned(mark, doc) {
    const blocks = doc.ast?.blocks || [];
    const blockIndex = blocks.findIndex((block) => block.id === mark.start?.blockId);
    const block = blocks[blockIndex] || {};
    return {
      externalId: mark.id,
      kind: mark.kind,
      category: mark.category,
      colorKey: mark.colorKey || mark.category,
      quote: mark.quote,
      prefix: mark.prefix,
      suffix: mark.suffix,
      comment: mark.comment,
      suggestion: mark.suggestion,
      status: mark.status,
      portableAnchor: {
        blockIndex: Math.max(0, blockIndex),
        blockType: block.type || 'paragraph',
        blockTextHash: this.textHash(blockText(block)),
        startOffset: mark.start?.offset || 0,
        endOffset: mark.end?.offset || mark.start?.offset || 0,
      },
      createdAt: mark.createdAt || 0,
      updatedAt: mark.updatedAt || 0,
    };
  }

  documentPortableHash(doc) {
    return this.textHash((doc.ast?.blocks || []).map((block) => blockText(block)).join('\n'));
  }

  textHash(value = '') {
    const text = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  xmlEscape(value = '') {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  }

  docxRunsFromHtml(html = '') {
    const root = document.createElement('div');
    root.innerHTML = html || '<br>';
    const runs = [];
    const walk = (node, style = {}) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (!text) return;
        const props = `${style.bold ? '<w:b/>' : ''}${style.italic ? '<w:i/>' : ''}`;
        runs.push(`<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${this.xmlEscape(text)}</w:t></w:r>`);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'BR') {
        runs.push('<w:r><w:br/></w:r>');
        return;
      }
      const next = {
        bold: style.bold || ['B', 'STRONG'].includes(node.tagName),
        italic: style.italic || ['I', 'EM'].includes(node.tagName),
      };
      [...node.childNodes].forEach((child) => walk(child, next));
    };
    [...root.childNodes].forEach((node) => walk(node));
    return runs.join('') || '<w:r><w:t></w:t></w:r>';
  }

  safeFileName(value = 'document') {
    return value.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'document';
  }

  createZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    Object.entries(files).forEach(([name, content]) => {
      const nameBytes = encoder.encode(name);
      const data = encoder.encode(content);
      const crc = this.crc32(data);
      const local = this.zipHeader(0x04034b50, [
        [20, 2], [0, 2], [0, 2], [0, 2], [0, 2], [crc, 4], [data.length, 4], [data.length, 4], [nameBytes.length, 2], [0, 2],
      ]);
      chunks.push(local, nameBytes, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += local.length + nameBytes.length + data.length;
    });
    let centralSize = 0;
    central.forEach((entry) => {
      const header = this.zipHeader(0x02014b50, [
        [20, 2], [20, 2], [0, 2], [0, 2], [0, 2], [0, 2], [entry.crc, 4], [entry.size, 4], [entry.size, 4], [entry.nameBytes.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4], [entry.offset, 4],
      ]);
      chunks.push(header, entry.nameBytes);
      centralSize += header.length + entry.nameBytes.length;
    });
    chunks.push(this.zipHeader(0x06054b50, [[0, 2], [0, 2], [central.length, 2], [central.length, 2], [centralSize, 4], [offset, 4], [0, 2]]));
    return new Blob(chunks);
  }

  zipHeader(signature, fields) {
    const length = 4 + fields.reduce((sum, [, size]) => sum + size, 0);
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    view.setUint32(0, signature, true);
    let pos = 4;
    fields.forEach(([value, size]) => {
      if (size === 2) view.setUint16(pos, value, true);
      else view.setUint32(pos, value >>> 0, true);
      pos += size;
    });
    return new Uint8Array(buffer);
  }

  crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i += 1) {
      crc ^= data[i];
      for (let j = 0; j < 8; j += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }

  async animateGenericExport(filename) {
    let overlay = document.getElementById('kb-import-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kb-import-overlay';
      overlay.className = 'kb-import-overlay';
      document.body.appendChild(overlay);
    }
    
    // Choose icon based on file extension
    const ext = filename.split('.').pop().toLowerCase();
    let iconClass = 'bx-cloud-upload';
    if (ext === 'docx') iconClass = 'bx-file';
    else if (ext === 'txt' || ext === 'md') iconClass = 'bx-align-left';
    else if (ext === 'html') iconClass = 'bx-code-alt';
    
    // Formulate steps
    let steps = [];
    if (ext === 'docx') {
      steps = [
        'Анализ структуры данных...',
        'Генерация разметки DOCX...',
        'Упаковка контента...',
        'Экспорт готов!'
      ];
    } else if (ext === 'txt' || ext === 'md') {
      steps = [
        'Сбор текстовых блоков...',
        'Кодирование в UTF-8...',
        'Экспорт готов!'
      ];
    } else if (ext === 'html') {
      steps = [
        'Сборка разметки HTML...',
        'Интеграция стилей...',
        'Экспорт готов!'
      ];
    } else if (ext.startsWith('nocturne') || ext.startsWith('nocturn')) {
      steps = [
        'Подготовка структуры JSON...',
        'Валидация чексуммы...',
        'Экспорт готов!'
      ];
    } else {
      steps = [
        'Подготовка данных...',
        'Экспорт готов!'
      ];
    }
    
    overlay.innerHTML = `
      <div class="kb-import-card">
        <div class="kb-import-spinner">
          <div class="spinner-ring"></div>
          <i class="bx ${iconClass}"></i>
        </div>
        <h3>Экспортируем файл...</h3>
        <div class="kb-import-progress-list"></div>
      </div>
    `;
    
    overlay.classList.add('active');
    await new Promise(r => setTimeout(r, 450));
    
    const listEl = overlay.querySelector('.kb-import-progress-list');
    for (let i = 0; i < steps.length; i++) {
      const step = document.createElement('div');
      step.className = 'kb-import-step success';
      step.style.animationDelay = `${i * 100}ms`;
      step.innerHTML = `<span>${steps[i]}</span><i class="bx bx-check-circle"></i>`;
      listEl.appendChild(step);
      await new Promise(r => setTimeout(r, 200));
    }
    
    await new Promise(r => setTimeout(r, 600));
    overlay.classList.remove('active');
  }

  async downloadBlob(blob, filename) {
    // If an export/import animation overlay is active, wait for it to finish
    while (document.getElementById('kb-import-overlay')?.classList.contains('active')) {
      await new Promise(r => setTimeout(r, 100));
    }

    await this.animateGenericExport(filename);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
  }

  async setSessionPassword() {
    const value = document.getElementById('session-password')?.value || '';
    this.state.sessionPassword = value;
    safeSetStorageItem(sessionStorage, 'nocturne-master-password', value);
    this.state.docs = await this.loadDocs();
    this.initWorkspace();
    this.renderAll();
    this.toast('Пароль сессии применен, документы перечитаны.');
  }

  promptForMasterPassword() {
    const overlay = document.getElementById('form-overlay');
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-shield-quarter"></i></div>
        <h2>Включить сквозное шифрование?</h2>
        <p>Для защиты ваших документов необходимо задать мастер-пароль сессии. Он будет использоваться для шифрования на этом устройстве.</p>
        <div class="form-field" style="margin: 16px 0; text-align: left;">
          <label style="display:block; margin-bottom:8px; font-size:12px; color:var(--text-muted); text-transform: uppercase;">Мастер-пароль сессии</label>
          <input class="form-control" type="password" id="prompt-master-password" placeholder="Введите пароль..." style="width:100%;">
        </div>
        <div class="form-actions">
          <button class="pill-btn" data-action="cancel-e2e">Отмена</button>
          <button class="pill-btn ai-btn" data-action="save-prompt-e2e">Включить</button>
        </div>
      </div>
    `;
    overlay.classList.add('active');
    
    const cancelBtn = overlay.querySelector('[data-action="cancel-e2e"]');
    const saveBtn = overlay.querySelector('[data-action="save-prompt-e2e"]');
    const input = overlay.querySelector('#prompt-master-password');
    
    cancelBtn.onclick = () => {
      this.state.settings.e2e = false;
      this.persistSettings();
      this.renderSettings();
      overlay.classList.remove('active');
    };
    
    const savePass = async () => {
      const pass = (input.value || '').trim();
      if (!pass) {
        this.toast('Пароль не может быть пустым.');
        return;
      }
      this.state.sessionPassword = pass;
      safeSetStorageItem(sessionStorage, 'nocturne-master-password', pass);
      overlay.classList.remove('active');
      this.state.docs = await this.loadDocs();
      // Encrypt all current plaintext documents immediately
      for (const doc of this.state.docs) {
        if (!doc.encrypted && !doc.locked) {
          await this.saveDocById(doc.id, { silent: true });
        }
      }
      this.initWorkspace();
      this.renderAll();
      this.toast('Шифрование включено. Все документы зашифрованы.');
    };
    
    saveBtn.onclick = savePass;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        savePass();
      }
    };
  }

  async disableE2eAndDecryptAll() {
    if (!this.state.sessionPassword) {
      const hasLocked = this.state.docs.some((doc) => doc.locked);
      if (hasLocked) {
        this.toast('Часть документов заблокирована. Сначала введите пароль для их расшифровки.');
        this.state.settings.e2e = true;
        this.persistSettings();
        this.renderSettings();
        return;
      }
    }
    
    // Decrypt and save all documents as plaintext
    for (const doc of this.state.docs) {
      if (doc.encrypted && !doc.locked) {
        await this.saveDocById(doc.id, { silent: true });
      }
    }
    this.state.docs = await this.loadDocs();
    this.initWorkspace();
    this.renderAll();
    this.toast('Шифрование отключено. Все документы расшифрованы.');
  }

  async resetData() {
    const overlay = document.getElementById('form-overlay');
    overlay.innerHTML = `
      <div class="form-modal confirm-modal">
        <div class="confirm-icon"><i class="bx bx-trash"></i></div>
        <h2>Сбросить локальную базу?</h2>
        <p>Будут удалены документы, лор, заметки, снапшоты и локальные настройки этого браузера.</p>
        <div class="form-actions">
          <button class="pill-btn" data-close-form>Отмена</button>
          <button class="pill-btn danger-btn" data-confirm-reset-data>Сбросить</button>
        </div>
      </div>`;
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-confirm-reset-data]').onclick = async () => this.performResetData();
  }

  async performResetData() {
    await Promise.all(['settings', 'folders', 'docs', 'lore', 'snapshots', 'stats', 'floatingNotes', 'typoRules', 'reviewMarks'].map((store) => this.db.clear(store)));
    const localPrefixes = [LIVE_PREFIX, 'goal-done-'];
    const localKeys = [
      'nocturne-global-notes',
      'nocturne-workspace-v1',
      'nocturne-review-mode',
      'nocturne-export-nocturned',
      'nocturne-collapsed-folders',
      'nocturne-writing-animation-choice',
    ];
    safeStorageKeys(localStorage).forEach((key) => {
      if (localKeys.includes(key) || localPrefixes.some((prefix) => key.startsWith(prefix))) safeRemoveStorageItem(localStorage, key);
    });
    ['nocturne-master-password'].forEach((key) => safeRemoveStorageItem(sessionStorage, key));
    location.reload();
  }

// --- syncActiveDocFromFocusedPane ---

  syncActiveDocFromFocusedPane() {

    const doc = this.getFocusedDoc();

    this.state.activeDocId = doc ? doc.id : null;

  }



// --- syncFloatingMenuPortalState ---

  syncFloatingMenuPortalState() {

    const portal = document.getElementById('floating-menu-portal');

    if (!portal) return;

    const hasOpenMenu = ['kb', 'format', 'split', 'notes', 'search', 'review']

      .some((key) => this.isFloatingMenuOpen(key));

    portal.setAttribute('aria-hidden', hasOpenMenu ? 'false' : 'true');

  }



// --- renderMobileSync ---

  renderMobileSync() {

    const s = this.state.sync;

    const preview = s.mergePreview;

    const remembered = (s.rememberedDevices || []).filter((item) => item.trusted).slice(0, 3);

    const discovered = s.discoveredDevices || [];

    const scanProgress = s.discovery.total ? Math.round((s.discovery.checked / s.discovery.total) * 100) : 0;

    return `

      ${this.mobilePanelHeader('Связь с компьютером', 'Локальная синхронизация по Wi‑Fi')}

      <div class="mobile-panel-body mobile-sync-body">

        <section class="mobile-sync-status ${escapeHtml(s.status)} compact" data-sync-status-card>

          ${iconSvg('phonePc', 'mobile-sync-icon')}

          <div>

            <strong data-sync-status-title>${this.syncStatusLabel(s.status)}</strong>

            <span data-sync-status-detail>${escapeHtml(s.statusDetail || 'Найдите компьютер в Wi‑Fi или введите адрес вручную.')}</span>

          </div>

        </section>



        ${remembered.length ? `<section class="sync-mobile-section"><div class="mobile-section-title">Быстрое подключение</div>${remembered.map((device) => this.renderSyncDeviceCard(device, 'remembered')).join('')}</section>` : ''}



        <section class="sync-mobile-section">

          <div class="mobile-section-title">Найденные компьютеры</div>

          <div class="sync-scan-row">

            <button class="pill-btn ai-btn" data-action="sync-scan">${iconSvg('scan', 'btn-svg')} Искать в Wi‑Fi</button>

            ${s.discovery.scanning ? `<button class="pill-btn" data-action="sync-scan-cancel"><i class="bx bx-stop"></i> Стоп</button>` : ''}

          </div>

          ${s.discovery.scanning ? `<div class="sync-progress"><span style="width:${scanProgress}%"></span></div><small>${s.discovery.checked}/${s.discovery.total} адресов</small>` : `<small>${escapeHtml(s.discovery.message || 'Поиск запускается только вручную и не работает в фоне.')}</small>`}

          ${discovered.length ? `<div class="sync-device-list">${discovered.map((device) => this.renderSyncDeviceCard(device, 'discovered')).join('')}</div>` : '<p class="form-helper">Если компьютер не найден, используйте ручной ввод ниже.</p>'}

        </section>



        <section class="sync-mobile-section">

          <button class="mobile-collapser" data-action="sync-toggle-manual">${iconSvg('server', 'mobile-action-svg')} <span>Ввести вручную</span><i class="bx bx-chevron-down"></i></button>

          ${s.discovery.manualOpen ? `<div class="mobile-sync-form compact">

            <label>Имя устройства<input class="form-control" data-sync-field="deviceName" value="${escapeHtml(s.deviceName || '')}" placeholder="Android телефон"></label>

            <label>IP компьютера<input class="form-control" data-sync-field="host" value="${escapeHtml(s.host || '')}" placeholder="192.168.1.10"></label>

            <div class="sync-two-cols">

              <label>Порт<input class="form-control" data-sync-field="port" value="${escapeHtml(s.port || '8787')}" inputmode="numeric"></label>

              <label>Код подключения<input class="form-control" data-sync-field="token" value="${escapeHtml(s.token || '')}" placeholder="код"></label>

            </div>

          </div>` : ''}

          <div class="mobile-panel-actions">

            <button class="pill-btn ai-btn" data-action="sync-connect">${iconSvg('sync', 'btn-svg')} Подключиться</button>

            <button class="pill-btn" data-action="sync-disconnect"><i class="bx bx-link-break"></i> Отключить</button>

            <button class="pill-btn" data-action="sync-request-merge"><i class="bx bx-transfer"></i> Сравнить базы</button>

          </div>

        </section>



        ${preview ? this.renderSyncMergePreview(preview) : '<p class="form-helper">Сервер только передаёт сообщения. Очереди, связи, конфликты и ревизии хранятся на этом устройстве в IndexedDB.</p>'}

      </div>`;

  }



// --- renderSyncDeviceCard ---

  renderSyncDeviceCard(device = {}, mode = 'discovered') {

    const id = escapeHtml(device.id || device.deviceId || device.publicDeviceId || '');

    const host = device.host || device.lastKnownIp || '';

    const port = device.port || device.lastKnownPort || '8787';

    const last = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'нет данных';

    const trusted = !!device.trusted;

    return `<article class="sync-device-card ${trusted ? 'trusted' : ''}">

      <div class="sync-device-icon">${iconSvg(device.deviceType === 'phone' ? 'phonePc' : 'server', 'sync-card-svg')}</div>

      <div class="sync-device-main">

        <strong>${escapeHtml(device.deviceName || 'Nocturne Sync')}</strong>

        <span>${escapeHtml(host || 'адрес неизвестен')}:${escapeHtml(String(port))} · ${mode === 'remembered' ? 'доверенное' : 'найдено'} · ${escapeHtml(last)}</span>

      </div>

      <div class="sync-device-actions">

        <button class="pill-btn mini" data-action="sync-connect-device" data-sync-device-id="${id}">${trusted ? 'Снова' : 'Подключить'}</button>

        ${mode === 'remembered' ? `<button class="btn-icon" title="Автоподключение" data-action="sync-toggle-autoreconnect" data-sync-device-id="${id}">${iconSvg(device.autoReconnect ? 'trust' : 'sync', 'icon-btn-svg')}</button><button class="btn-icon" title="Забыть" data-action="sync-forget-device" data-sync-device-id="${id}"><i class="bx bx-trash"></i></button>` : ''}

      </div>

    </article>`;

  }



// --- syncStatusLabel ---

  syncStatusLabel(status) {

    return {

      offline: 'Не подключено',

      waiting: 'Ожидание',

      connected: 'Подключено',

      syncing: 'Синхронизация',

      error: 'Ошибка',

      conflict: 'Есть конфликт',

    }[status] || 'Не подключено';

  }



// --- renderSyncMergePreview ---

  renderSyncMergePreview(preview) {

    const stats = preview.stats || {};

    const folders = preview.connectFolders || [];

    return `<section class="sync-preview-card">

      <h3>Предпросмотр объединения</h3>

      <div class="dump-summary-grid">

        <span><strong>${stats.docs || 0}</strong> глав</span>

        <span><strong>${stats.folders || 0}</strong> папок</span>

        <span><strong>${stats.characters || 0}</strong> персонажей</span>

        <span><strong>${stats.locations || 0}</strong> локаций</span>

        <span><strong>${stats.timeline || 0}</strong> событий</span>

        <span><strong>${stats.subtimelines || 0}</strong> сабтаймлайнов</span>

        <span><strong>${stats.notes || 0}</strong> заметок</span>

        <span><strong>${stats.conflicts || 0}</strong> конфликтов</span>

      </div>

      <p class="form-helper">Будут созданы/использованы папки: ${folders.map(escapeHtml).join(', ') || 'нет'}. Настройки не будут перезаписаны.</p>

      <div class="mobile-panel-actions">

        <button class="pill-btn ai-btn" data-action="sync-apply-merge"><i class="bx bx-check"></i> Применить объединение</button>

        <button class="pill-btn" data-action="sync-clear-preview"><i class="bx bx-x"></i> Отмена</button>

      </div>

    </section>`;

  }



// --- renderSyncStatus ---

  renderSyncStatus() {

    document.querySelectorAll('[data-sync-status]').forEach((el) => {

      el.textContent = this.syncStatusLabel(this.state.sync.status);

      el.className = `sync-status-pill ${this.state.sync.status}`;

    });

  }



// --- updateSyncStatusUi ---

  updateSyncStatusUi() {

    this.renderSyncStatus();

    const status = this.state.sync.status;

    const label = this.syncStatusLabel(status);

    const detail = this.state.sync.statusDetail || 'Найдите компьютер в Wi-Fi или введите адрес вручную.';

    document.querySelectorAll('[data-sync-status-card]').forEach((card) => {

      card.className = `mobile-sync-status compact ${status}`;

    });

    document.querySelectorAll('[data-sync-status-title]').forEach((el) => {

      el.textContent = label;

    });

    document.querySelectorAll('[data-sync-status-detail]').forEach((el) => {

      el.textContent = detail;

    });

  }



// --- isLocalSyncDevice ---

  isLocalSyncDevice(device = {}) {

    const publicId = device.publicDeviceId || device.id;

    if (publicId && publicId === this.state.sync.server.publicDeviceId) return true;

    if (publicId && publicId === this.state.sync.publicDeviceId) return true;

    const serverIps = new Set([...(this.state.sync.server.lanIps || []), '127.0.0.1', 'localhost']);

    return serverIps.has(device.host) && String(device.port || '') === String(this.state.sync.server.port || '');

  }



// --- applySyncServerStatus ---

  applySyncServerStatus(payload = {}) {

    const server = this.state.sync.server;

    server.canControl = !!payload.canControl || server.canControl;

    server.running = !!payload.running;

    server.port = String(payload.port || server.port || '8787');

    server.token = String(payload.token || server.token || '');

    server.publicDeviceId = String(payload.publicDeviceId || server.publicDeviceId || '');

    server.lanIps = Array.isArray(payload.lanIps) ? payload.lanIps : [];

    server.startedAt = payload.startedAt || null;

    server.output = payload.output || '';

    if (server.running) {

      this.state.sync.port = server.port;

      this.state.sync.token = server.token || this.state.sync.token;

      this.state.sync.host = this.preferredLanIps(server.lanIps)[0] || this.state.sync.host || '127.0.0.1';

      safeSetStorageItem(localStorage, 'nocturne-sync-host', this.state.sync.host);

      safeSetStorageItem(localStorage, 'nocturne-sync-port', this.state.sync.port);

      safeSetStorageItem(localStorage, 'nocturne-sync-token', this.state.sync.token);

    }

  }



// --- candidateSyncHosts ---

  candidateSyncHosts() {

    const hosts = new Set();

    const add = (host) => {

      const value = String(host || '').trim();

      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return;

      if (value.startsWith('127.') && this.isAndroidRuntime()) return;

      hosts.add(value);

    };

    add(this.state.sync.host);

    this.preferredLanIps(this.state.sync.server.lanIps || []).forEach(add);

    (this.state.sync.rememberedDevices || []).forEach((device) => add(device.lastKnownIp || device.host));

    const seed = [...hosts].find((host) => this.isPrivateLanIp(host));

    if (seed && !seed.startsWith('127.')) {

      const parts = seed.split('.');

      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;

      for (let i = 1; i <= 254; i += 1) hosts.add(`${prefix}${i}`);

    } else {

      if (!this.isAndroidRuntime()) add('127.0.0.1');

      ['192.168.0', '192.168.1', '192.168.31', '192.168.50', '192.168.88', '192.168.100', '10.0.0', '10.0.1'].forEach((prefix) => {

        for (let i = 1; i <= 254; i += 1) hosts.add(`${prefix}.${i}`);

      });

    }

    return [...hosts].slice(0, 900);

  }



// --- cancelSyncDiscoveryScan ---

  cancelSyncDiscoveryScan() {

    if (this.syncScanAbort) this.syncScanAbort.cancelled = true;

    this.state.sync.discovery.scanning = false;

    this.state.sync.discovery.message = 'Поиск остановлен.';

    this.renderSyncSurfaces();

  }



// --- renderSyncSurfaces ---

  renderSyncSurfaces() {

    if (this.isMobileLayout()) this.renderMobileShell();

    else if (document.getElementById('form-overlay')?.classList.contains('active')) this.renderOpenSyncPanel();

  }



// --- disconnectLocalSync ---

  disconnectLocalSync() {

    this.syncClient.disconnect();

    this.toast('Локальная связь отключена.');

  }



// --- buildSyncMergePreview ---

  buildSyncMergePreview(message) {

    const payload = message.dump?.payload || {};

    const lore = payload.lore || {};

    const timeline = lore.timeline || [];

    const deviceName = message.deviceName || 'устройство';

    const folderTitle = this.remoteConnectFolderTitle(message);

    const stats = {

      docs: payload.docs?.length || 0,

      folders: payload.folders?.length || 0,

      characters: lore.characters?.length || 0,

      locations: lore.locations?.length || 0,

      timeline: timeline.length,

      subtimelines: timeline.reduce((sum, item) => sum + (item.subEvents?.length || 0), 0),

      notes: payload.floatingNotes?.length || 0,

      conflicts: (payload.docs || []).filter((doc) => this.state.docs.some((local) => local.id === doc.id)).length,

    };

    return {

      remoteDeviceId: message.from,

      remoteDeviceName: deviceName,

      stats,

      connectFolders: [folderTitle],

      receivedAt: Date.now(),

    };

  }



// --- openSyncPanel ---

  openSyncPanel() {

    const overlay = document.getElementById('form-overlay');

    if (!overlay) return;

    overlay.innerHTML = this.renderDesktopSyncCenter();

    overlay.classList.add('active');

    overlay.querySelectorAll('[data-close-form]').forEach((button) => {

      button.onclick = () => overlay.classList.remove('active');

    });

  }



// --- renderOpenSyncPanel ---

  renderOpenSyncPanel() {

    const overlay = document.getElementById('form-overlay');

    if (!overlay?.classList.contains('active')) return;

    overlay.innerHTML = this.renderDesktopSyncCenter();

    overlay.querySelectorAll('[data-close-form]').forEach((button) => {

      button.onclick = () => overlay.classList.remove('active');

    });

  }



// --- renderDesktopSyncCenter ---

  renderDesktopSyncCenter() {

    const s = this.state.sync;

    const server = s.server || {};

    const discovered = s.discoveredDevices || [];

    const remembered = s.rememberedDevices || [];

    const scanProgress = s.discovery.total ? Math.round((s.discovery.checked / s.discovery.total) * 100) : 0;

    const preferredIps = this.preferredLanIps(server.lanIps || []);

    const infoRows = [

      ['Адрес в сети', preferredIps.join(', ') || s.host || 'не найден'],

      ['Порт', server.port || s.port || '8787'],

      ['Код подключения', server.token || s.token || 'запустите сервер'],

    ];

    return `

      <div class="form-modal sync-center-modal">

        <div class="sync-center-head">

          <div class="sync-center-title">

            <span class="sync-center-logo">${iconSvg('phonePc', 'sync-center-logo-svg')}</span>

            <div><h2>Локальная связь</h2><p>Синхронизация телефона и компьютера по Wi‑Fi</p></div>

          </div>

          <div class="sync-center-head-actions">

            <span class="sync-status-pill ${escapeHtml(s.status)}" data-sync-status>${escapeHtml(this.syncStatusLabel(s.status))}</span>

            <button class="btn-icon" data-close-form><i class="bx bx-x"></i></button>

          </div>

        </div>



        <section class="sync-center-hero">

          <div class="sync-hero-icon">${iconSvg('phonePc', 'sync-center-logo-svg')}</div>

          <div>

            <span>${server.running ? 'Компьютер готов к подключению' : 'Сервер ещё не запущен'}</span>

            <strong>${server.running ? 'Телефон может подключиться по Wi‑Fi' : (server.canControl || this.runtime?.isElectron ? 'Запустите сервер одной кнопкой' : 'Проверьте внешний sync server')}</strong>

            <p>${escapeHtml(server.message || 'Сервер работает только как локальный брокер. Данные проекта остаются на устройствах.')}</p>

          </div>

          <button class="pill-btn ai-btn sync-hero-action" data-action="${server.running ? 'sync-copy-info' : 'sync-server-start'}">${server.running ? iconSvg('copy', 'btn-svg') : iconSvg('server', 'btn-svg')} ${server.running ? 'Скопировать данные' : 'Запустить сервер'}</button>

        </section>



        <div class="sync-center-grid">

          <section class="sync-center-card sync-server-card">

            <div class="sync-card-head">${iconSvg('server', 'sync-card-head-icon')}<div><strong>Сервер на компьютере</strong><span>${server.canControl ? 'Управление доступно из приложения' : 'Браузерный режим: запуск сервера снаружи'}</span></div></div>

            <div class="sync-server-status ${server.running ? 'online' : 'offline'}">

              <span>${server.running ? 'Сервер запущен' : 'Сервер не запущен'}</span>

              <small>${escapeHtml(server.message || (server.canControl ? 'Запуск доступен только по явному нажатию.' : 'Проверьте уже запущенный сервер или скопируйте команду запуска.'))}</small>

            </div>

            <div class="sync-info-grid">${infoRows.map(([label, value]) => `<span><small>${label}</small><strong>${escapeHtml(value)}</strong></span>`).join('')}</div>

            <div class="sync-card-actions">

              <button class="pill-btn ai-btn" data-action="sync-server-start">${iconSvg('server', 'btn-svg')} Запустить сервер</button>

              <button class="pill-btn" data-action="sync-server-stop"><i class="bx bx-stop"></i> Остановить</button>

              <button class="pill-btn" data-action="sync-server-check"><i class="bx bx-refresh"></i> Проверить</button>

              <button class="pill-btn" data-action="sync-server-refresh-token"><i class="bx bx-key"></i> Новый код</button>

              <button class="pill-btn" data-action="sync-copy-info">${iconSvg('copy', 'btn-svg')} Скопировать</button>

            </div>

          </section>



          <section class="sync-center-card">

            <div class="sync-card-head">${iconSvg('scan', 'sync-card-head-icon')}<div><strong>Обнаружение в сети</strong><span>Поиск по Wi‑Fi ограничен по времени; ручной ввод остаётся запасным путём.</span></div></div>

            <div class="sync-card-actions">

              <button class="pill-btn ai-btn" data-action="sync-scan">${iconSvg('scan', 'btn-svg')} Искать устройства</button>

              ${s.discovery.scanning ? `<button class="pill-btn" data-action="sync-scan-cancel"><i class="bx bx-stop"></i> Остановить</button>` : ''}

            </div>

            ${s.discovery.scanning ? `<div class="sync-progress"><span style="width:${scanProgress}%"></span></div><small>${s.discovery.checked}/${s.discovery.total} адресов проверено</small>` : `<p class="form-helper">${escapeHtml(s.discovery.message || 'Поиск запускается только пользователем, ограничен по времени и не работает в фоне.')}</p>`}

            <div class="sync-device-list">${discovered.length ? discovered.map((device) => this.renderSyncDeviceCard(device, 'discovered')).join('') : '<p class="form-helper">Пока ничего не найдено.</p>'}</div>

          </section>



          <section class="sync-center-card">

            <div class="sync-card-head">${iconSvg('trust', 'sync-card-head-icon')}<div><strong>Доверенные устройства</strong><span>Автоподключение включается только после успешной привязки.</span></div></div>

            <div class="sync-device-list">${remembered.length ? remembered.map((device) => this.renderSyncDeviceCard(device, 'remembered')).join('') : '<p class="form-helper">Доверенных устройств пока нет.</p>'}</div>

          </section>



          <section class="sync-center-card">

            <div class="sync-card-head">${iconSvg('sync', 'sync-card-head-icon')}<div><strong>Подключение и merge</strong><span>Сервер не хранит историю. Очереди, связи и конфликты остаются в IndexedDB клиентов.</span></div></div>

            <div class="form-grid compact">

              <label>Имя устройства <input class="form-control" data-sync-field="deviceName" value="${escapeHtml(s.deviceName || '')}"></label>

              <label>IP компьютера <input class="form-control" data-sync-field="host" value="${escapeHtml(s.host || '127.0.0.1')}" placeholder="192.168.1.10"></label>

              <label>Порт <input class="form-control" data-sync-field="port" value="${escapeHtml(s.port || '8787')}" inputmode="numeric"></label>

              <label>Код подключения <input class="form-control" data-sync-field="token" value="${escapeHtml(s.token || '')}"></label>

            </div>

            <div class="sync-card-actions">

              <button class="pill-btn ai-btn" data-action="sync-connect">${iconSvg('sync', 'btn-svg')} Подключиться</button>

              <button class="pill-btn" data-action="sync-disconnect"><i class="bx bx-link-break"></i> Отключить</button>

              <button class="pill-btn" data-action="sync-request-merge"><i class="bx bx-transfer"></i> Сравнить базы</button>

            </div>

            ${s.mergePreview ? this.renderSyncMergePreview(s.mergePreview) : ''}

          </section>



          <section class="sync-center-card sync-diagnostics-card">

            <div class="sync-card-head">${iconSvg('trust', 'sync-card-head-icon')}<div><strong>Диагностика</strong><span>Что сейчас известно приложению.</span></div></div>

            <div class="sync-diagnostics-list">

              <span><i class="bx ${this.runtime?.isElectron ? 'bx-check-circle' : 'bx-info-circle'}"></i> Runtime: ${escapeHtml(this.runtime?.platform || 'browser')}</span>

              <span><i class="bx ${server.canControl ? 'bx-check-circle' : 'bx-error-circle'}"></i> Управление сервером: ${server.canControl ? 'доступно' : 'недоступно'}</span>

              <span><i class="bx ${server.running ? 'bx-check-circle' : 'bx-radio-circle'}"></i> LAN IP: ${escapeHtml(preferredIps.join(', ') || 'не найден')}</span>

              <span><i class="bx bx-shield-quarter"></i> Discovery не отдаёт код подключения или данные проекта.</span>

            </div>

          </section>

        </div>



        <details class="sync-help">

          <summary>Как подключить?</summary>

          <p>На ПК запустите сервер кнопкой выше или командой <code>npm run sync:server</code>. На телефоне откройте “Связь с компьютером”, найдите ПК в Wi‑Fi или введите IP, порт и код вручную. Поиск не публикует код подключения и не отдаёт данные проекта.</p>

        </details>

      </div>`;

  }



// --- connectLocalSyncFromUi ---

async connectLocalSyncFromUi() {

    const { host, port, token, deviceName } = this.state.sync;

    if (!host || !token) {

      this.toast('Введите IP компьютера и код подключения.');

      return;

    }

    if (this.isAndroidRuntime() && /^127\./.test(String(host))) {

      this.state.sync.status = 'error';

      this.state.sync.statusDetail = '127.0.0.1 на телефоне — это сам телефон, а не компьютер. Введите LAN IP ПК.';

      this.updateSyncStatusUi();

      return;

    }

    safeSetStorageItem(localStorage, 'nocturne-sync-device-name', deviceName || defaultDeviceName(this.runtime));

    safeSetStorageItem(localStorage, 'nocturne-sync-host', host);

    safeSetStorageItem(localStorage, 'nocturne-sync-port', port || '8787');

    safeSetStorageItem(localStorage, 'nocturne-sync-token', token);

    this.state.sync.status = 'waiting';

    this.state.sync.statusDetail = 'Проверяю /discovery на указанном адресе...';

    this.updateSyncStatusUi();

    try {

      const device = await this.probeSyncDiscoveryHost(host, port || '8787', 'manual');

      if (!device) throw new Error('wrong protocol');

      this.state.sync.statusDetail = device.pairingRequired ? 'Сервер найден, нужен код подключения.' : 'Сервер найден.';

      this.updateSyncStatusUi();

    } catch (error) {

      this.state.sync.status = 'error';

      this.state.sync.statusDetail = `Сервер не найден: ${error?.name === 'AbortError' ? 'timeout' : (error?.message || 'host unreachable')}.`;

      this.updateSyncStatusUi();

      return;

    }

    try {

      await this.syncClient.connect({ host, port, token, trusted: true });

    } catch (error) {

      this.state.sync.status = 'error';

      this.state.sync.statusDetail = error?.message || 'Подключение не удалось.';

      this.updateSyncStatusUi();

    }

  }



// --- probeSyncDiscoveryHost ---

async probeSyncDiscoveryHost(host, port = this.state.sync.port || '8787', method = 'manual') {

    const payload = await this.httpGetJson(`${buildHttpBase(host, port)}/discovery`, 750);

    return this.normalizeDiscoveredDevice(payload, host, port, method);

  }



// --- preferredLanIps ---

  preferredLanIps(ips = []) {

    const clean = [...new Set((ips || []).filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))))];

    return [

      ...clean.filter((ip) => this.isPrivateLanIp(ip) && !ip.startsWith('127.')),

      ...clean.filter((ip) => !this.isPrivateLanIp(ip) && !ip.startsWith('127.')),

      ...clean.filter((ip) => ip.startsWith('127.')),

    ];

  }



// --- isPrivateLanIp ---

  isPrivateLanIp(ip = '') {

    const parts = String(ip).split('.').map((part) => Number(part));

    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

    if (parts[0] === 10) return true;

    if (parts[0] === 192 && parts[1] === 168) return true;

    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

    return false;

  }



// --- remoteConnectFolderTitle ---

  remoteConnectFolderTitle(message) {

    const name = message.deviceName || 'устройство';

    const source = /android|phone|тел/i.test(name) ? 'С телефона' : 'С компьютера';

    return `${source} — ${name}`;

  }



// --- scanForSyncServers ---

async scanForSyncServers() {

    if (this.state.sync.discovery.scanning) return;

    const hosts = this.candidateSyncHosts();

    const port = this.state.sync.port || '8787';

    const discovery = this.state.sync.discovery;

    discovery.scanning = true;

    discovery.checked = 0;

    discovery.total = hosts.length;

    discovery.error = '';

    discovery.message = 'Идёт поиск в Wi-Fi...';

    this.state.sync.discoveredDevices = [];

    const token = { cancelled: false };

    this.syncScanAbort = token;

    this.renderSyncSurfaces();



    const found = new Map();

    const startedAt = Date.now();

    let index = 0;

    const concurrency = 12;

    const maxDuration = 12000;

    const worker = async () => {

      while (!token.cancelled && index < hosts.length && Date.now() - startedAt < maxDuration) {

        const host = hosts[index++];

        try {

          const device = await this.probeSyncDiscoveryHost(host, port, 'subnet-scan');

          if (device && !this.isLocalSyncDevice(device) && !found.has(device.id)) found.set(device.id, device);

        } catch (error) {

          if (!discovery.error) discovery.error = error?.name === 'AbortError' ? 'timeout' : (error?.message || 'host unreachable');

        }

        discovery.checked += 1;

        if (discovery.checked % 8 === 0 || found.size) this.renderSyncSurfaces();

      }

    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    discovery.scanning = false;

    discovery.message = token.cancelled

      ? 'Поиск остановлен.'

      : (found.size ? 'Компьютеры найдены.' : `Компьютеры не найдены${discovery.error ? ` (${discovery.error})` : ''}. Проверьте, что ПК и телефон в одной Wi-Fi сети, сервер запущен и IP не 127.0.0.1.`);

    this.state.sync.discoveredDevices = [...found.values()];

    this.syncScanAbort = null;

    this.renderSyncSurfaces();

  }



// --- normalizeDiscoveredDevice ---

  normalizeDiscoveredDevice(payload, host, port, method = 'scan') {

    if (!payload || payload.service !== 'nocturne-sync') return null;

    return {

      id: `${payload.publicDeviceId || host}:${port}`,

      publicDeviceId: payload.publicDeviceId || '',

      deviceName: payload.deviceName || 'Nocturne Sync',

      deviceType: payload.deviceType || 'computer',

      host,

      port: String(payload.port || port),

      discoveryMethod: method,

      protocolVersion: payload.protocolVersion || SYNC_PROTOCOL_VERSION,

      pairingRequired: payload.pairingRequired !== false,

      lastSeenAt: Date.now(),

    };

  }



// --- httpGetJson ---

async httpGetJson(url, timeoutMs = 650) {

    if (window.Capacitor?.Plugins?.Http?.get) {

      const result = await window.Capacitor.Plugins.Http.get({ url, connectTimeout: timeoutMs, readTimeout: timeoutMs });

      return typeof result.data === 'string' ? JSON.parse(result.data) : result.data;

    }

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {

      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      return await response.json();

    } finally {

      clearTimeout(timer);

    }

  }





  toast(message, duration = 2200) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('active');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => toast.classList.remove('active'), duration);
  }

  confetti() {
    for (let i = 0; i < 70; i += 1) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = ['var(--accent)', '#22c55e', '#f59e0b', '#0ea5e9'][i % 4];
      c.style.animationDelay = `${Math.random() * 380}ms`;
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 1800);
    }
  }
}

const app = new NocturneWriter();
window.nocturneApp = app;
app.init().catch((error) => {
  console.error(error);
  const appRoot = document.getElementById('app') || document.body.appendChild(document.createElement('div'));
  document.body.classList.add('boot-error');
  appRoot.innerHTML = `
    <main class="app-error-screen">
      <section class="app-error-panel">
        <div class="confirm-icon"><i class="bx bx-error-circle"></i></div>
        <h1>Не удалось запустить Nocturne</h1>
        <p data-error-message></p>
        <div class="form-actions">
          <button class="pill-btn ai-btn" type="button" data-error-reload>Перезагрузить</button>
          <button class="pill-btn" type="button" data-error-reset-ui>Сбросить UI-настройки</button>
        </div>
      </section>
    </main>`;
  appRoot.querySelector('[data-error-message]').textContent = error?.message || 'Проверьте доступ к IndexedDB/localStorage и повторите запуск.';
  appRoot.querySelector('[data-error-reload]').onclick = () => location.reload();
  appRoot.querySelector('[data-error-reset-ui]').onclick = () => {
    safeRemoveStorageItem(localStorage, 'nocturne-workspace-v1');
    safeRemoveStorageItem(localStorage, 'nocturne-review-mode');
    safeRemoveStorageItem(localStorage, 'nocturne-collapsed-folders');
    location.reload();
  };
});

