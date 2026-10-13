const shared = ['desktop', 'android'];
const scenarioReports = {
  'audit-data':'audit-data-regressions.json', 'audit-editor':'audit-editor-regressions.json', 'audit-sync':'audit-sync-regressions.json', 'audit-platform':'audit-platform-regressions.json',
  'pagination':'pagination-regressions.json', 'pagination-interaction':'pagination-interaction.json', 'pagination-viewport':'pagination-viewport.json',
  'responsive-ui':'ui-results.json', 'android-polish':'android-polish/results.json', 'surface-motion':'surface-motion.json', 'app-motion':'app-motion.json',
};
const check = (id, args, areas, options = {}) => ({ id, args, areas, platforms: shared, executable: process.execPath, timeout: 120_000, modes: ['full'], ports: [], scenarioReport:scenarioReports[id], ...options });

export const PROJECT_CHECKS = [
  check('syntax', ['scripts/check-source.mjs'], ['source'], { modes: ['smoke', 'full'] }),
  check('unit', ['--test', 'scripts/test-database-sync.mjs', 'scripts/test-project-backups.mjs', 'scripts/test-smart-speller.mjs', 'scripts/test-sync-auth.mjs'], ['database', 'sync', 'backups', 'dictionary', 'security']),
  check('smart-dictionary', ['--import', './scripts/qa/observe-playwright.mjs', 'scripts/test-smart-dictionary.mjs'], ['dictionary', 'writing', 'settings'], { ownScenarioReport: 'results.json' }),
  check('audit-data', ['scripts/test-audit-data.mjs'], ['database', 'security', 'import', 'backups'], { ports: [5310, 8910] }),
  check('audit-editor', ['scripts/test-audit-editor.mjs'], ['writing', 'dictionary', 'pagination', 'review'], { ports: [5311, 8911] }),
  check('audit-sync', ['scripts/test-audit-sync.mjs'], ['sync', 'security'], { ports: [5312, 8912, 8913] }),
  check('audit-platform', ['scripts/test-audit-platform.mjs'], ['native-desktop', 'import', 'export'], { platforms: ['desktop'], systems: ['win32'], ports: [5314, 8914] }),
  check('pagination', ['scripts/test-pagination.mjs'], ['writing', 'pagination'], { ports: [5315, 8915] }),
  check('pagination-interaction', ['scripts/test-pagination-interaction.mjs'], ['writing', 'pagination', 'selection'], { ports: [5321, 8921] }),
  check('pagination-viewport', ['scripts/test-pagination-viewport.mjs'], ['pagination', 'responsive'], { ports: [5326, 8926] }),
  check('pagination-performance', ['scripts/benchmark-pagination-resize.mjs', '--pages=53', '--page-mode=split', '--shape=single-paragraph', '--animate', '--label=verification', '--assert', '--budget-ms=32'], ['pagination', 'performance'], { ports: [5322, 8922] }),
  check('release-tools', ['scripts/test-release-tools.py'], ['release'], { executable: 'python' }),
  check('editor-adapter', ['scripts/test-editor-adapter.mjs'], ['writing', 'database'], { modes: ['smoke', 'full'] }),
  check('bookmark-model', ['--test', 'scripts/test-bookmark-model.mjs'], ['writing', 'database', 'backups']),
  check('bookmarks-ui', ['scripts/test-bookmarks-ui.mjs'], ['writing', 'lore', 'settings', 'touch', 'navigation', 'selection', 'backups'], { ports: [5333, 8933], scenarioReport: 'bookmarks-ui/results.json', timeout: 180_000 }),
  check('bookmarks-design', ['scripts/test-bookmarks-design.mjs'], ['writing', 'lore', 'settings', 'motion', 'touch', 'navigation', 'accessibility', 'visual'], { ports: [5334, 8934], scenarioReport: 'bookmarks-design/results.json', timeout: 180_000 }),
  check('ai-context', ['scripts/test-ai-context.mjs'], ['ai', 'lore']),
  check('workflow-model', ['--test', 'scripts/test-workflow-model.mjs'], ['writing', 'search', 'settings']),
  check('questionnaire-workflow', ['scripts/test-questionnaire-workflow.mjs'], ['writing', 'search', 'backups', 'ai', 'lore', 'settings', 'motion', 'responsive'], { ports: [5335], timeout: 180_000, ownScenarioReport: 'results.json' }),
  check('interface-polish', ['scripts/test-interface-polish.mjs'], ['settings', 'lore', 'backups', 'motion', 'responsive', 'accessibility', 'visual'], { ports: [5336], timeout: 180_000, ownScenarioReport: 'results.json' }),
  check('reliability', ['scripts/test-reliability.mjs'], ['database', 'writing', 'backups'], { ports: [5276] }),
  check('workflow-tools', ['scripts/test-workflow-tools.mjs'], ['writing', 'security', 'import', 'export', 'backups', 'ai', 'review'], { modes: ['smoke', 'full'], ports: [5282] }),
  check('lan-integration', ['scripts/test-lan-sync.mjs'], ['sync', 'database'], { ports: [5277, 8880] }),
  check('native-desktop', ['scripts/test-native-desktop.mjs'], ['native-desktop', 'sync', 'backups'], { platforms: ['desktop'], systems: ['win32'], ports: [5285, 8885] }),
  check('offline-assets', ['scripts/test-offline-assets.mjs'], ['offline'], { ports: [5286] }),
  check('platform-contract', ['scripts/test-sync-platform.mjs'], ['native-contract', 'sync', 'export']),
  check('production-assets', ['scripts/test-build.mjs'], ['release', 'offline']),
  check('desktop-smoke', ['scripts/desktop-smoke.mjs'], ['writing', 'lore', 'settings'], { platforms: ['desktop'], modes: ['smoke', 'full'], ports: [5173] }),
  check('responsive-ui', ['scripts/ui-qa.mjs'], ['responsive', 'export', 'lore'], { ports: [5281] }),
  check('mobile-behavior', ['scripts/test-mobile-behavior.mjs'], ['touch', 'keyboard', 'navigation', 'responsive'], { platforms: ['android'], modes: ['smoke', 'full'], ports: [5288] }),
  check('android-polish', ['scripts/test-android-polish.mjs'], ['writing', 'touch', 'keyboard', 'selection', 'navigation', 'settings', 'lore', 'review', 'import', 'security', 'ai', 'responsive'], { platforms: ['android'], timeout: 240_000, ports: [5293] }),
  check('interface-revision', ['scripts/test-interface-revision.mjs'], ['settings', 'lore', 'navigation'], { ports: [5290, 8890] }),
  check('surface-motion', ['scripts/test-surface-motion.mjs'], ['motion', 'navigation'], { ports: [5292, 8892] }),
  check('dropdown-motion', ['--import', './scripts/qa/observe-playwright.mjs', 'scripts/test-dropdown-motion.mjs'], ['settings', 'navigation', 'motion', 'responsive', 'keyboard', 'accessibility', 'visual'], { ownScenarioReport: 'results.json' }),
  check('app-motion', ['scripts/test-app-motion.mjs'], ['motion', 'lore', 'navigation'], { ports: [5294, 8894] }),
  check('review-mode-ui', ['--import', './scripts/qa/observe-playwright.mjs', 'scripts/test-review-mode-ui.mjs'], ['writing', 'review', 'motion', 'responsive', 'accessibility'], { ownScenarioReport: 'results.json' }),
  check('knowledge-search', ['--import', './scripts/qa/observe-playwright.mjs', 'scripts/test-knowledge-search.mjs'], ['lore', 'search', 'notes', 'responsive', 'keyboard', 'accessibility'], { ownScenarioReport: 'results.json', timeout: 180_000 }),
  check('character-rename', ['--import', './scripts/qa/observe-playwright.mjs', 'scripts/test-character-rename.mjs'], ['lore', 'writing', 'notes', 'database', 'security', 'responsive', 'keyboard', 'touch', 'accessibility', 'motion'], { ownScenarioReport: 'results.json', timeout: 240_000 }),
  check('name-inflections', ['--test', '--experimental-test-coverage', '--test-coverage-include=src/core/name-inflections.js', 'scripts/test-name-inflections.mjs'], ['lore', 'writing', 'search', 'ai', 'dictionary']),
];

export const ARTIFACT_CHECKS = [
  check('packaged-desktop', ['scripts/test-native-desktop.mjs', '--packaged'], ['native-desktop', 'release', 'writing'], { platforms: ['desktop'], systems: ['win32'], ports: [5285, 8885], artifact: '.electron_build/dist/win-unpacked/Nocturne Writer.exe' }),
  check('android-artifact', ['scripts/inspect-android-artifact.py'], ['release', 'native-contract'], { platforms: ['android'], executable: 'python', artifact: 'Nocturne-Writer-debug.apk' }),
  check('desktop-artifact', ['scripts/inspect-desktop-artifact.mjs'], ['release'], { platforms: ['desktop'], artifact: '.electron_build/dist/win-unpacked/Nocturne Writer.exe' }),
];

export const EXTRA_CHECKS = [
  check('motion-corrections', ['scripts/test-motion-corrections.mjs'], ['settings', 'selection', 'motion', 'responsive', 'accessibility', 'visual'], { modes: [], ports: [5339], timeout: 600_000, ownScenarioReport: 'results.json' }),
  check('visual-fixes', ['scripts/test-visual-fixes.mjs'], ['settings', 'selection', 'motion', 'responsive', 'accessibility', 'visual'], { modes: [], ports: [5338], timeout: 420_000, ownScenarioReport: 'results.json' }),
  check('visual-controls-audit', ['scripts/audit-visual-controls.mjs'], ['settings', 'motion', 'responsive', 'accessibility', 'visual'], { modes: [], ports: [5337], timeout: 420_000, ownScenarioReport: 'results.json' }),
  check('settings-copy-report', ['scripts/test-settings-copy-report.mjs'], ['source', 'settings', 'accessibility', 'responsive'], { platforms: ['desktop'], ownScenarioReport: 'results.json' }),
  check('tester-contract', ['--test', 'scripts/qa/test-runner.mjs'], ['source'], { modes: ['smoke', 'full'] }),
  check('cross-platform-journey', ['scripts/qa/cross-platform-journey.mjs'], ['writing', 'database', 'navigation', 'settings', 'responsive', 'accessibility', 'visual', 'offline', 'stress'], { modes: ['smoke', 'full'], timeout: 420_000, ownScenarioReport:'results.json' }),
  check('native-android', ['scripts/qa/native-android.mjs'], ['native-android', 'keyboard', 'navigation'], { platforms: ['android'], timeout: 90_000 }),
];

export const DIAGNOSTIC_SCRIPTS = [
  { file: 'scripts/test-audit-visual.mjs', reason: 'Compares against a historical pre-redesign baseline; requires a separately reviewed visual reference.' },
  { file: 'scripts/test-pagination-visual.mjs', reason: 'Compares against the historical pagination baseline; intentional current mobile changes alter appearance.' },
  { file: 'scripts/test-sound.mjs', reason: 'Legacy diagnostic uses obsolete localStorage settings and removed UI selectors; it has no behavioral assertions.' },
  { file: 'scripts/test-scroll.mjs', reason: 'Legacy diagnostic uses obsolete localStorage settings and removed UI selectors; scroll behavior is covered by current pagination/Android suites.' },
  { file: 'scripts/test-trace.mjs', reason: 'Standalone image pixel inspection, without application behavior assertions or reliable failure status.' },
];

export const AREA_LABELS = {
  search: 'Поиск',
  notes: 'Заметки',
  source: 'Исходники', database: 'Сохранность данных', writing: 'Письмо', selection: 'Выделение и буфер', pagination: 'Страницы', dictionary: 'Словарь', review: 'Редактура', lore: 'База знаний', settings: 'Настройки', navigation: 'Навигация', touch: 'Жесты', keyboard: 'Клавиатура', responsive: 'Размеры и поворот', motion: 'Анимации', accessibility: 'Доступность', visual: 'Визуальные состояния', stress: 'Повторяемые действия', ai: 'Ассистент', import: 'Импорт', export: 'Экспорт', backups: 'Копии и восстановление', sync: 'Синхронизация', security: 'Шифрование и защита', offline: 'Офлайн', performance: 'Производительность', release: 'Упаковка', 'native-contract': 'Платформенные контракты', 'native-desktop': 'Настоящий Electron', 'native-android': 'Настоящий Android WebView',
};
