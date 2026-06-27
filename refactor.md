# План безопасного рефактора main.js и CSS

## Цель

Разбить внутреннюю структуру `src/main.js` и стилей на понятные файлы без визуальных изменений, без изменения пользовательских сценариев, без смены формата данных и без переписывания приложения на новый фреймворк.

Главный критерий успеха: после каждого шага приложение выглядит и работает так же, как до шага. Рефактор считается успешным только если изменилось расположение кода, а не поведение.

## Что сейчас видно по проекту

- `src/main.js` весит примерно 870 KB и содержит почти все приложение в классе `NocturneWriter`.
- Внутри одного класса смешаны загрузка данных, нормализация моделей, рендер всего интерфейса, обработчики событий, мобильная оболочка, редактор, поиск, AI, импорт/экспорт, база знаний, заметки, review-режим, синхронизация и системные настройки.
- Уже есть вынесенные модули: `src/core/db.js`, `src/core/defaults.js`, `src/core/utils.js`, `src/core/crypto.js`, `src/features/command-palette.js`, `src/features/ai-context.js`, `src/features/local-sync.js`, `src/editor/*`, `src/platform/*`, `src/ui/icons.js`.
- `index.html` сейчас подключает CSS из `src/css/variables.css`, `src/css/animations.css`, `src/css/ui.css`, `src/css/experimental.css`.
- Документация проекта при этом говорит, что канонический файл стилей - `src/styles.css`, а CSS partials являются фрагментами. Это конфликт источника истины.
- `src/styles.css` содержит около 222 KB стилей и похож на исторический монолит. В конце есть повторяющиеся блоки для paper theme, pagination и drag-and-drop overlay.
- `src/css/ui.css` почти такого же размера, как `src/styles.css`, и фактически уже является главным UI-файлом для текущего `index.html`.
- В `src/main.js` есть признаки ручных/скриптовых вставок: большие блоки с комментариями вида `--- sync ---`, неравномерные отступы, повторяющиеся названия методов вроде `buildSyncMergePreview`, дублирование обязанностей между рендером и бизнес-логикой.

## Нельзя менять во время рефактора

- Визуальные классы, DOM id, `data-action`, `data-*` контракты и ARIA-атрибуты, если нет отдельной задачи на UI.
- Ключи IndexedDB и localStorage/sessionStorage.
- Формат документов, lore, review marks, floating notes, sync mappings, project dump и `.nocturnedump`.
- Публичную точку `window.nocturneApp`, пока от нее потенциально зависят smoke-тесты, отладка или Electron.
- Поведение `NocturneEditorBridge`, Tiptap bundle и `src/editor/*` без отдельного этапа.
- Runtime-абстракции: нельзя напрямую тащить `fs`, Electron или Capacitor в новые browser-модули; использовать `src/platform/file-adapter.js` и `src/platform/runtime.js`.
- Нельзя делать форматирование всего `main.js` одной правкой. Это уничтожит возможность понять реальный diff.

## Общая стратегия

Рефактор должен идти не по принципу "разрезать файл на куски", а по принципу "сначала стабилизировать границы, потом переносить системы".

`src/main.js` на первых этапах остается entrypoint и владельцем сборки приложения. Новые модули получают узкий доступ к приложению через явный `app`-контекст или чистые функции. После каждого переноса `main.js` должен импортировать новый модуль и отдавать ему ровно ту ответственность, которую перенесли.

CSS нужно сначала привести к одному источнику истины. Пока `index.html` подключает `src/css/*`, рефакторить только `src/styles.css` бессмысленно для браузерного результата. Нужно либо сделать `src/css/*` каноном и обновить документацию/сборку, либо вернуть `src/styles.css` как канон и генерировать partials из него. Для текущего состояния безопаснее закрепить `src/css/*` как рабочий источник, а `src/styles.css` считать legacy/compat до отдельного решения.

## Предлагаемая целевая структура JS

Ниже структура, к которой стоит прийти постепенно. Это не список файлов для создания за один коммит.

### `src/app/bootstrap.js`

Ответственность: создание `NocturneWriter`, запуск `init`, обработка boot error, сохранение `window.nocturneApp`.

Что остается в `src/main.js` на переходном этапе: только импорты и вызов bootstrap.

Почему первым не выносить весь класс: слишком большой риск сломать замыкания, порядок инициализации и обработчики.

### `src/app/nocturne-writer.js`

Ответственность: тонкий класс-композитор приложения.

В финале здесь должны остаться:
- constructor;
- `init`;
- сборка state;
- подключение модулей;
- вызовы `renderAll`;
- общие утилитарные мосты, которые пока не имеют дома.

Здесь не должны жить большие шаблоны HTML, AI-промпты, CSS-зависимая мобильная навигация, DOCX zip, sync scanning и алгоритмы подсветки.

### `src/app/storage.js`

Ответственность:
- безопасный доступ к localStorage/sessionStorage;
- `safeGetStorageItem`, `safeSetStorageItem`, `safeRemoveStorageItem`, `safeStorageKeys`, `safeParseJson`;
- накопление и показ storage warnings через простой экспортируемый список/сервис;
- `LIVE_PREFIX`.

Ограничение: не менять ключи и тексты ошибок в тот же коммит, где переносится код.

### `src/app/state-normalizers.js`

Ответственность:
- `validateSettings`;
- `validateFolders`;
- `sanitizeDoc`;
- `sanitizeTypoRule`;
- `sanitizeReviewMark`;
- `sanitizeFloatingNote`;
- `normalizeNote`;
- `normalizeCharacter`;
- `normalizeLocation`;
- `normalizeTimelineEvent`;
- `splitCharacterName`.

Это хороший ранний этап, потому что эти функции почти не должны зависеть от DOM. Их проще покрыть минимальными тестами.

### `src/app/workspace.js`

Ответственность:
- workspace state;
- panes;
- split mode;
- focused pane;
- open/close pane;
- workspace persistence;
- pane title/kind helpers.

Сюда переносить только логику рабочей области, не HTML редактора и не CSS.

### `src/ui/shell-view.js`

Ответственность:
- общий HTML shell;
- порталы;
- toolbar markup;
- side panels containers;
- preloader orchestration, если он не уйдет в отдельный `preloader.js`.

Важно: этот модуль должен возвращать HTML/обновлять контейнеры, но не принимать решения о данных документов.

### `src/ui/mobile-view.js`

Ответственность:
- mobile topbar;
- system bar;
- bottom nav;
- mobile tab surface;
- mobile overlay/panel;
- mobile route snapshot/back logic;
- mobile viewport classes.

Почему отдельно: мобильная часть имеет собственные состояния, back behavior, safe area, keyboard behavior и touch selection. Ее нельзя смешивать с desktop toolbar.

### `src/ui/dom-events.js`

Ответственность:
- единое место для регистрации глобальных событий;
- делегирование click/input/change/key/pointer events в app controllers;
- защита от повторной регистрации слушателей.

Первый шаг здесь: вынести только `bindGlobalEvents`, не переписывая сами handlers. Потом постепенно выносить handlers в профильные модули.

### `src/features/actions.js`

Ответственность:
- карта `data-action` -> app method;
- разбор common dataset;
- общие guards.

Это уменьшит самый рискованный метод `runAction`, где сейчас слишком много unrelated команд: документы, AI, настройки, KB, импорт/экспорт, demo data, notes, sync.

### `src/features/documents/`

Файлы:
- `document-model.js` - создание, дублирование, сортировка, folder helpers;
- `document-view.js` - sidebar docs markup, folder empty state, doc cards;
- `document-import.js` - импорт TXT/MD/HTML/DOCX/PDF/Nocturned;
- `document-dnd.js` - Sortable для документов и drag-to-pane;
- `document-save.js` - live draft, snapshots, save debounce.

Ограничение: не менять формат `doc.ast`. Все функции должны продолжать работать с текущими блоками.

### `src/features/editor/`

Файлы:
- `legacy-editor-dom.js` - legacy contenteditable операции, если они еще нужны рядом с Tiptap;
- `selection-controller.js` - caret snapshot, mobile selection, custom selection layer;
- `formatting.js` - inline commands, block type, alignment;
- `pagination.js` - legacy pagination helpers, если они не принадлежат `src/editor/visual-pagination.js`;
- `readability-highlights.js` - readability, weak words, writer syntax;
- `typo-highlights.js` - typo range building and highlight updates.

Важно: сначала проверить, что уже делает `NocturneEditorBridge`, чтобы не дублировать ответственность. Новые файлы не должны конкурировать с `src/editor/nocturne-editor.js`.

### `src/features/review/`

Ответственность:
- review marks model;
- anchor serialization/resolution;
- toolbar slot;
- navigator;
- accept/reject suggestion;
- review categories and labels.

Это логически связано с AI, но не должно жить внутри AI-модуля: review marks могут создаваться вручную.

### `src/features/search/`

Ответственность:
- document search;
- global search;
- replace;
- entity mentions search window;
- search highlight lifecycle.

Важная граница: поиск может читать документы и DOM редактора, но не должен сохранять документы сам, кроме операций replace.

### `src/features/notes/`

Ответственность:
- document/global notes;
- floating notes;
- floating notes manager;
- drag/resize/pin/minimize;
- note checklist snippets.

Проверить отдельно mobile behavior, потому что заметки видны и в desktop side panel, и в mobile panels.

### `src/features/knowledge-base/`

Ответственность:
- characters;
- locations;
- timeline;
- subtimelines;
- lore detail;
- KB modal;
- import/export KB;
- KB drag/drop ordering.

Границу с entity mentions держать аккуратно: построение mention index может быть в `features/entities/entity-index.js`, а KB остается владельцем данных.

### `src/features/entities/`

Ответственность:
- entity mention index;
- entity decorations для legacy HTML;
- hover cards;
- family hover;
- opening entity detail from links.

Если Tiptap entity mentions уже есть в `src/editor/nocturne-editor.js`, этот модуль должен дать ему данные, а не переписывать extension.

### `src/features/settings/`

Ответственность:
- settings modal;
- tabs;
- custom select;
- accent picker;
- provider presets;
- macro UI;
- applying side effects.

Разделить на `settings-view.js`, `settings-registry.js`, `settings-effects.js`, потому что сейчас registry/search/render/effects смешаны.

### `src/features/assistant/`

Ответственность:
- provider settings validation;
- prompt building;
- request streaming;
- response parsing and repair;
- suggestion lifecycle;
- AI context preview integration;
- sentiment graph if он останется AI tool.

Границы:
- `src/features/ai-context.js` уже есть, его не дублировать.
- создание review marks после AI ответа лучше вызывать через review module.
- вставку текста в документ лучше вызывать через editor/document API, а не напрямую трогать DOM.

### `src/features/sync/`

Ответственность:
- `LocalSyncClient`;
- remembered devices;
- discovery scan;
- sync queue;
- merge preview;
- conflict copies;
- desktop/mobile sync UI.

Важно: в проекте уже есть `src/features/local-sync.js`; перед созданием новых sync-файлов нужно понять, почему часть sync осталась в `main.js`. Возможно, правильный шаг - расширить существующий модуль, а не создавать параллельный.

### `src/features/export/`

Ответственность:
- printable export;
- DOCX export;
- project dump export/import;
- `.nocturned` review payload;
- zip helpers.

Граница: crypto остается в `src/core/crypto.js`; file IO остается через `platformFiles`.

### `src/features/demo-data.js`

Ответственность:
- add/remove demo docs;
- add/remove demo lore;
- add/remove demo timeline;
- full demo set.

Это низкорисковый кандидат на раннее вынесение после normalizers.

## Предлагаемая целевая структура CSS

Перед любым CSS-рефактором выбрать один вариант.

### Вариант A: `src/css/*` как источник истины

Это ближе к текущему `index.html`.

Структура:
- `src/css/variables.css` - только design tokens, theme variables, root values.
- `src/css/animations.css` - только keyframes and animation utility classes.
- `src/css/base.css` - reset, body, selection, common typography.
- `src/css/layout.css` - app shell, sidebar, toolbar, workspace, panes.
- `src/css/editor.css` - page, ProseMirror, pagination, caret, selection layer, readability.
- `src/css/documents.css` - sidebar docs, folders, doc context menu, DnD overlay.
- `src/css/mobile.css` - Android/mobile shell, topbar, bottom nav, panels, keyboard states.
- `src/css/modals.css` - form modal, settings modal, command palette, shortcuts.
- `src/css/knowledge-base.css` - KB modal, cards, lore detail, timeline, subtimelines.
- `src/css/notes.css` - notes panel, floating notes, manager.
- `src/css/review.css` - review toolbar, chips, navigator, highlights.
- `src/css/search.css` - document/global search and replace.
- `src/css/assistant.css` - AI panel, suggestion bar, AI context preview.
- `src/css/sync.css` - sync center, device cards, sync status.
- `src/css/themes.css` - midnight, paper, matrix, lavender, crimson and theme overrides.
- `src/css/experimental.css` - experimental design only.

Then `index.html` imports these files in a stable order.

### Вариант B: `src/styles.css` как источник истины

Это ближе к `AGENTS.md` and `README.md`.

Структура:
- keep editing partials in `src/css/*`;
- add a CSS build script that concatenates partials into `src/styles.css`;
- make `index.html` load only `src/styles.css`;
- document that partials are source and `styles.css` is generated output.

This is better for production if fewer requests matter, but needs a build step and a clear generated-file policy.

### Рекомендация по CSS

Для этого проекта безопаснее сначала выбрать Вариант A, потому что current `index.html` already loads `src/css/*`. Затем обновить docs so they stop saying `src/styles.css` is canonical. `src/styles.css` should either be removed from runtime or generated only for compatibility after behavior is stable.

Нельзя одновременно вручную править `src/styles.css` and `src/css/ui.css`; that guarantees drift.

## Порядок работ

### Этап 0. Зафиксировать baseline

Цель: понять, что именно считается "не изменилось".

Действия:
- Создать отдельную ветку для рефактора.
- Убедиться, что есть чистая или хотя бы понятная рабочая копия. Если есть чужие изменения, не смешивать их с рефактором.
- Запустить `npm run check`.
- Запустить `npm run dev` and `npm run smoke:desktop`.
- Сделать baseline screenshots desktop and mobile: first load, editor, docs sidebar, KB modal, settings, AI panel, notes, mobile shell, sync center if available.
- Сохранить список подключенных CSS-файлов из `index.html`.

Выход этапа: known-good baseline or documented blockers.

### Этап 1. Навести карту зависимостей без переноса кода

Цель: получить понятную карту перед изменениями.

Действия:
- Составить список методов `NocturneWriter` по группам: app lifecycle, storage, workspace, mobile, events, editor, documents, notes, KB, settings, AI, search, review, export, sync.
- Отметить методы, которые трогают DOM.
- Отметить методы, которые пишут в IndexedDB/localStorage/sessionStorage.
- Отметить методы, которые используют network, platformFiles, Capacitor, Sortable, Tiptap.
- Отметить дубли: `buildSyncMergePreview`, sync UI helpers, CSS blocks in `styles.css`.

Выход этапа: карта для переноса. Код приложения не меняется.

### Этап 2. Зафиксировать CSS source of truth

Цель: убрать конфликт между документацией, `src/styles.css` and `src/css/*`.

Действия:
- Решить: runtime использует partials или monolith.
- Если выбран вариант A, обновить docs and build expectations: runtime CSS is `src/css/*`; `src/styles.css` is legacy/reference until removed.
- Если выбран вариант B, добавить build step for CSS concat and load only `src/styles.css`.
- Не менять визуальные значения и селекторы в этом же этапе.

Проверки:
- `npm run check`.
- Browser smoke: app loads, theme settings work, experimental boot class works.
- Screenshot diff should show no intended visual changes.

### Этап 3. Вынести storage helpers

Цель: убрать из `main.js` безопасные helpers без UI-риска.

Перенос:
- safe storage methods;
- JSON parse helper;
- storage warning collection;
- default device name only if sync module is not ready yet, otherwise later.

Почему рано: эти функции маленькие and shared.

Проверки:
- app starts if localStorage is available;
- app starts if storage access throws in simulated environment if such test is added;
- `npm run check`.

### Этап 4. Вынести normalizers and validators

Цель: отделить чистую модель данных от UI.

Перенос:
- settings validation;
- folders validation;
- doc, typo rule, review mark, floating note sanitizers;
- lore item normalizers.

Правило: no DOM, no db writes inside this module.

Проверки:
- app loads existing IndexedDB data;
- settings reset still works;
- importing old/partial data still produces valid state;
- `npm run check`.

### Этап 5. Разделить bootstrap and app shell

Цель: сделать `main.js` entrypoint instead of app monolith.

Действия:
- Move boot error handling into bootstrap module.
- Keep `window.nocturneApp`.
- Keep public app lifecycle same.
- Extract render shell HTML into a UI module only after bootstrap is stable.

Проверки:
- boot success;
- forced boot error screen still renders;
- reload/reset UI buttons still work;
- `npm run check`.

### Этап 6. Вынести global event registration and action map

Цель: уменьшить риск в `bindGlobalEvents` and `runAction`.

Порядок:
- Сначала вынести только регистрацию событий as a function receiving `app`.
- Потом вынести action map as a function receiving `app`, `event`, `action`.
- Не менять names of `data-action`.
- Не менять order of event listeners unless necessary.

Проверки:
- toolbar buttons;
- modals open/close;
- keyboard shortcuts;
- drag and drop import overlay;
- mobile back;
- command palette;
- `npm run smoke:desktop`.

### Этап 7. Вынести workspace and panes

Цель: isolate split-screen and pane state.

Перенос:
- pane descriptor helpers;
- workspace persistence;
- focused pane methods;
- open/close/toggle split;
- pane title/kind helpers;
- pane body routing can remain temporary in app until views are extracted.

Проверки:
- open document;
- open KB in right pane;
- close secondary pane;
- drag document to pane;
- persisted workspace after reload;
- mobile should not regress.

### Этап 8. Вынести documents feature

Цель: separate sidebar document management and document persistence.

Порядок:
- Move document model helpers first.
- Move folder helpers.
- Move sidebar view.
- Move import handlers.
- Move Sortable/DnD last.

Проверки:
- create folder/doc;
- rename/delete folder;
- create/duplicate/delete doc;
- pin doc;
- search docs;
- import txt/md/html/docx if fixtures exist;
- document drag reorder;
- split-pane document drag.

### Этап 9. Вынести editor-adjacent legacy logic

Цель: isolate fragile DOM editing code.

Порядок:
- selection snapshot and restore;
- custom selection layer;
- toolbar state;
- formatting commands;
- legacy contenteditable block operations;
- pagination helpers;
- readability and typo highlights.

Ограничение: do not touch `NocturneEditorBridge` behavior unless a failing test proves the boundary is wrong.

Проверки:
- typing;
- paste plain/multiline text;
- undo/redo;
- bold/italic;
- headings/quotes;
- selection toolbar state;
- mobile long press/selection handles;
- custom caret;
- typo underline;
- readability modes;
- auto pagination/flexible pages.

### Этап 10. Вынести review and search

Цель: separate editing aids from core editor.

Review:
- marks storage;
- create mark from selection;
- resolve anchors;
- toolbar;
- navigator;
- accept/reject.

Search:
- current document search;
- global search;
- replace;
- highlights;
- entity mentions search.

Проверки:
- manual review issue;
- AI-created review mark still displays;
- accept/reject suggestion;
- current document search next/prev;
- global search open result;
- replace one and replace all preview.

### Этап 11. Вынести notes

Цель: isolate document/global/floating notes.

Порядок:
- note save/render;
- floating note model helpers;
- floating note view;
- drag/resize behavior;
- manager and mobile notes.

Проверки:
- document note saves;
- global note saves;
- E2E setting removes localStorage global notes path correctly;
- create temporary/document/global/lore floating notes;
- pin/minimize/close/delete;
- drag/resize desktop;
- mobile notes panel.

### Этап 12. Вынести knowledge base

Цель: isolate lore domain.

Порядок:
- type normalization and entity lookup;
- cards and detail view;
- forms;
- subtimelines;
- KB modal;
- KB import/export;
- Sortable ordering.

Проверки:
- characters/locations/timeline/notes tabs;
- create/edit/delete all lore types;
- subtimeline open/close/create event;
- associated documents;
- entity links in editor still work;
- KB search;
- mobile KB reorder.

### Этап 13. Вынести settings

Цель: isolate settings UI and side effects.

Порядок:
- settings registry;
- settings content renderers;
- custom select;
- accent picker;
- macro UI;
- side effects;
- persistence.

Проверки:
- theme switch;
- accent picker;
- font settings;
- editor spacing;
- toolbar sticky;
- e2e toggle flow;
- AI provider presets;
- macro record/save/delete;
- settings search.

### Этап 14. Вынести AI assistant

Цель: isolate provider/request/prompt/response complexity.

Порядок:
- provider guards and headers/body;
- context options and preview;
- prompt builders;
- response parsers;
- repair flow;
- streaming request;
- suggestion lifecycle;
- review mark creation integration.

Проверки:
- local provider unavailable error;
- provider preset test;
- sentiment graph;
- continue/style suggestion accept/reject;
- proofread/lore-check creates review marks;
- invalid AI response does not insert unsafe text.

### Этап 15. Вынести import/export and encryption flows

Цель: isolate file and archive behavior.

Порядок:
- project dump build/validate/import;
- `.nocturned` payload;
- printable export;
- DOCX generation;
- zip helpers;
- E2E password flows.

Проверки:
- export project dump;
- import project dump merge/replace;
- encrypted project flow;
- export printable;
- export docx;
- review marks included in `.nocturned` when enabled.

### Этап 16. Вынести sync

Цель: isolate LAN sync as its own subsystem.

Порядок:
- move `LocalSyncClient`;
- remembered devices and mappings;
- queue and patches;
- merge preview;
- discovery scan;
- sync UI.

Перед переносом проверить `src/features/local-sync.js` and decide whether to extend it or replace old sync code with it.

Проверки:
- start/stop/check sync server where supported;
- manual host connect;
- Android 127.0.0.1 guard;
- discovery scan cancel;
- request merge;
- conflict copy;
- remembered device persistence.

### Этап 17. Разбить CSS без визуальных изменений

Цель: split stylesheet by responsibility.

Порядок:
- Freeze CSS source-of-truth first.
- Move blocks by selector ownership, not by visual guess.
- Keep import order stable: variables, animations, base, layout, feature files, themes, experimental.
- Do not rename selectors.
- Do not consolidate colors, spacing, shadows or z-indexes in the same pass.
- Remove exact duplicate blocks only after proving cascade result is unchanged.

Проверки:
- desktop screenshot comparison;
- mobile screenshot comparison;
- themes: nocturne, paper, matrix, lavender, crimson;
- experimental design toggle;
- command palette;
- settings modal;
- KB modal;
- mobile shell and keyboard state;
- pagination and page sheets.

### Этап 18. Clean-up after extraction

Цель: remove transition glue.

Действия:
- Remove duplicated methods from `NocturneWriter`.
- Remove dead CSS files or mark generated files clearly.
- Update `AGENTS.md`, `README.md`, and any build notes.
- Add small architecture note describing module ownership.
- Keep `main.js` as small entrypoint.

Проверки:
- `npm run check`;
- `npm run build`;
- `npm run smoke:desktop`;
- manual mobile viewport smoke;
- review git diff for accidental visual/style value changes.

## Рекомендуемый порядок коммитов

1. Baseline docs and dependency map only.
2. CSS source-of-truth decision and docs update.
3. Storage helpers extraction.
4. State normalizers extraction.
5. Bootstrap extraction.
6. Global events/action map extraction.
7. Workspace extraction.
8. Documents extraction.
9. Editor selection/formatting extraction.
10. Review/search extraction.
11. Notes extraction.
12. Knowledge base extraction.
13. Settings extraction.
14. AI assistant extraction.
15. Export/import extraction.
16. Sync extraction.
17. CSS split.
18. Final cleanup and docs.

Каждый коммит должен проходить минимальную проверку. Если коммит большой и не проходит проверку, он слишком большой.

## Что тестировать после каждого этапа

Минимум:
- `npm run check`;
- открыть приложение через `npm run dev`;
- создать/открыть документ;
- напечатать текст;
- сохранить и перезагрузить;
- открыть настройки;
- открыть KB;
- открыть notes;
- проверить desktop toolbar.

После UI/CSS/mobile этапов:
- desktop width около 1440 px;
- tablet/mobile width около 390 px;
- mobile keyboard/focus behavior conceptually and technically;
- no overlapping text;
- no hidden overlays blocking interaction;
- safe-area and bottom nav not covering content.

После data/export/sync этапов:
- project dump import/export;
- encrypted data path if E2E enabled;
- IndexedDB stores unchanged;
- localStorage/sessionStorage keys unchanged;
- sync conflict path if possible.

## Главные риски

- CSS source-of-truth conflict: `styles.css` and `src/css/ui.css` can diverge.
- `NocturneWriter` currently uses many implicit `this` dependencies. Moving methods blindly will break hidden call chains.
- `runAction` is a central dispatcher; changing it can silently break many buttons.
- Mobile behavior is tightly coupled to CSS classes on `body`.
- Selection/caret logic is fragile because it depends on DOM ranges, viewport scroll and editor state.
- AI review and manual review share marks. Splitting AI before review boundaries are clear can duplicate logic.
- Sync code touches network, IndexedDB, localStorage and UI at once. It should be moved late.
- Existing git tree is dirty; refactor must not mix unrelated changes.

## Definition of done

- `src/main.js` is reduced to a small bootstrap/composition layer plus temporary bridges only where justified.
- Feature modules have clear ownership and do not duplicate each other.
- CSS has exactly one runtime source-of-truth.
- Visual output is unchanged across desktop and mobile baseline screenshots except for unavoidable antialiasing noise.
- `npm run check`, `npm run build`, and `npm run smoke:desktop` pass.
- Project documentation matches the final file structure.
- No storage keys, data formats, exports, imports, or sync protocol changed unintentionally.
