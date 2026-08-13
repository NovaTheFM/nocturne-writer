# Технический аудит производительности и исправления Nocturne Writer

---

## 0. Внешние библиотеки и зависимости

> **Заключение по библиотекам:**  
> Все 3 описанные проблемы являются **архитектурными проблемами управления DOM, layout thrashing и обработкой событий**, и могут быть полностью решены на чистом **Vanilla JS + CSS containment + браузерных API (`requestAnimationFrame`, `IntersectionObserver`, CSS Highlight API)** без утяжеления приложения новым бандлом.
> 
> Однако, если рассматривать внедрение сторонней микро-библиотеки для гарантированного устранения *Layout Thrashing* (принудительных синхронных перерисовок), рекомендуется единственная ультра-легкая библиотека:
> 
> - **`FastDOM`** (размер ~1 KB gzipped, без сторонних зависимостей).
>   - **Зачем:** Автоматически пакетирует и очередирует операции чтения из DOM (`fastdom.measure`) и записи в DOM (`fastdom.mutate`), исключая микро-рефлоу при высокой частоте кадров.
>   - **Почему:** В `observeKbGridResize` и `renderNocturneSelectionLayer` браузер вынужден последовательно выполнять считывание размеров (`getBoundingClientRect`) и изменение стилей (`animate`, `style.left`), что вызывает Layout Thrashing. `FastDOM` гарантированно разделяет фазы чтения и записи.

---

## 1. Оптимизация режима Split-Screen и анимаций карточек Базы Знаний

### 1.1. Доказательная база и техническая причина проблемы (Root Cause)

При перетаскивании разделителя сплит-скрина (`#workspace-divider`) частота кадров снижается до ~5 FPS, если с одной стороны открыта База Знаний с карточками (`.character-grid`, `.locations-grid`). 

На основе анализа кода выявлены следующие **фундаментальные причины**:

1. **Forced Synchronous Layout (Layout Thrashing) в `ResizeObserver`**
   - **Где в коде:** [`src/main.js:16305-16388`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L16305-L16388) (`observeKbGridResize`).
   - **Механика сбоя:** На каждый тик движения мыши при драге сплит-скрина активируется `ResizeObserver`. Внутри обработчика выполняется цикл по ВСЕМ карточкам в сетке (`zone.querySelectorAll('.char-card, .loc-card, .timeline-item, .note-card')`). 
   - На каждой карточке в цикле вызывается `card.getBoundingClientRect()` ([`src/main.js:16331`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L16331)), после чего синхронно сбрасываются анимации `cancelElementAnimations(c)` ([`src/main.js:16327`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L16327)) и запускаются новые `card.animate(...)` ([`src/main.js:16357`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L16357)). В функции `onfinish` каждой анимации повторно вызывается `card.getBoundingClientRect()` ([`src/main.js:16371`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L16371)).
   - **Результат:** За один кадр происходят десятки принудительных сбросов и перерасчетов макета браузера (Reflow/Repaint).

2. **Конфликт Web Animations API и CSS Transitions**
   - **Где в коде:** [`src/css/ui.css:4870`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/css/ui.css#L4870) и [`src/css/ui.css:10756`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/css/ui.css#L10756).
   - **Механика сбоя:** Для карточек прописаны CSS-переходы: `transition: border-color 180ms ease, background-color 180ms ease, box-shadow 220ms ease, opacity 180ms ease, transform 220ms...`.
   - Одновременно с этим `observeKbGridResize` динамически запускает JS-анимации через `card.animate([{ transform: ... }, { transform: ... }])`.
   - Браузер вынужден параллельно рассчитывать матрицу `transform` из Web Animations API и CSS Transitions, выходя из аппаратно-ускоренного слоя композитинга.

3. **Избыточные FLIP-расчеты для невидимых карточек вне Viewport**
   - **Механика сбоя:** Запрос `zone.querySelectorAll(...)` выбирает абсолютно ВСЕ карточки в контейнере, включая сотни карточек, находящихся ниже области видимости за границами прокрутки (`overflow-y: auto`). FLIP-расчет координат и создание 100+ объектов `Animation` в секунду для невидимых элементов сжирает CPU главного потока.

4. **Отсутствие каскадной изоляции макета (CSS Containment)**
   - Изменение ширины CSS-переменных `--split-primary` и `--split-secondary` на родительском `#workspace-stage` заставляет браузер рекурсивно пересчитывать геометрическое дерево всего документа, включая текстовые блоки редактора и элементы управления.

---

### 1.2. Предлагаемое решение (Без изменения внешнего вида и без поломки анимаций)

> ⚠️ **Сохранение функционала и дизайна:**  
> Все анимации перетекания карточек, растягивания, переноса на новые строки при изменении ширины и плавность FLIP остаются 100% визуально идентичными текущему состоянию. Меняется только подкапотный движок расчетов.

1. **Изоляция перерисовок контейнера (CSS Containment):**
   - Для контейнеров `.character-grid` и `.locations-grid` добавить CSS-свойства изоляции макета:
     ```css
     .character-grid, .locations-grid {
       contain: layout paint;
     }
     .char-card, .loc-card, .note-card {
       will-change: transform;
       backface-visibility: hidden;
     }
     ```
   - Это гарантирует, что перерасчет ширины колонок в сетке не будет вызывать рефлоу внешнего документа и соседей по Split-Screen.

2. **Фильтрация FLIP-анимаций по области видимости (Viewport Filtering via IntersectionObserver):**
   - В метод `observeKbGridResize` добавить проверку видимости карточек через `IntersectionObserver` или быстрый прямолинейный check видимости относительно `scrollTop`/`clientHeight` контейнера.
   - FLIP-анимация `card.animate(...)` запускается **только для карточек, находящихся на экране**. Для закадровых карточек координаты в `prevPosMap` обновляются мгновенно без создания объектов `Animation`.

3. **Пакетное разделение чтения и записи (Batching / FastDOM pattern):**
   - Разделить процесс `observeKbGridResize` на две строгие фазы:
     - **Фаза 1 (Чтение):** Одним массивом собрать все `getBoundingClientRect()` у видимых карточек.
     - **Фаза 2 (Запись):** Запустить необходимые `card.animate()` без промежуточных вызовов измерения свойств в цикле.

4. **Ингибирование CSS Transitions во время FLIP:**
   - На время работы `card.animate()` на элемент временно добавляется утилитарный класс `.is-flipping`, отключающий CSS `transition: transform`, благодаря чему Web Animations API работает на чистом GPU без микро-задержек.

---

## 2. Устранение лагов кастомного выделения текста Nocturne

### 2.1. Доказательная база и техническая причина проблемы (Root Cause)

Кастомное выделение текста начинает сильно лагать при работе с большими документами или при длительном использовании.

На основе анализа кода выявлены **три ключевые проблемы**:

1. **Высокочастотный вызов тяжелых операций при движении мыши (Unthrottled `mousemove` Handlers)**
   - **Где в коде:** [`src/main.js:3529`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L3529) (`handleTypoMouseMove`) и [`src/main.js:3528`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L3528) (`handleEntityMouseMove`).
   - **Механика сбоя:** Когда пользователь зажимает левую кнопку мыши и тащит курсор для выделения текста, браузер генерирует события `mousemove` с частотой до 240 Гц.
   - На КАЖДЫЙ пиксель движения вызывается `handleTypoMouseMove`, внутри которого срабатывает `findTypoMatchAtPoint(event.clientX, event.clientY, editable)` ([`src/main.js:6158`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L6158)).
   - Внутри `findTypoMatchAtPoint`:
     - Вызывается `document.caretRangeFromPoint(x, y)` ([`src/main.js:5990`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L5990)) — тяжелейший нативный метод браузера, который **принудительно сбрасывает и пересчитывает макет (Forced Synchronous Reflow)**!
     - Создается клонированный диапазон `pre.selectNodeContents(block)` и выполняется `pre.toString().length` ([`src/main.js:6006`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L6006)) для подсчета символов в абзаце.
     - Выполняется линейный поиск `this.typoMatchIndex.find(...)` ([`src/main.js:6009`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L6009)) по всему массиву опечаток документа $O(N)$.
   - **Почему лагает на больших документах:** Массив `typoMatchIndex` вырастает до тысяч элементов, а длинные абзацы замедляют `pre.toString()`.
   - **Почему лагает при длительном выделении:** Параллельно с выделением выполняются сотни неверных поисков опечаток под курсором, хотя пользователь просто выделяет текст.

2. **Деструктивная регенерация DOM в `renderNocturneSelectionLayer`**
   - **Где в коде:** [`src/main.js:5166-5230`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L5166-L5230).
   - **Механика сбоя:** При каждом движении выделения вызывается `renderNocturneSelectionLayer()`.
   - Функция берет прямоугольники `range.getClientRects()`, строит строку из HTML и делает `layer.innerHTML = ${highlights}${handles}` ([`src/main.js:5229`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L5229)).
   - При `innerHTML` старые DOM-узлы `<span class="nocturne-selection-rect">` уничтожаются, а новые создаются с нуля 60-120 раз в секунду. Это создаёт колоссальную нагрузку на сборщик мусора (Garbage Collector pauses) и вызывает фризы.

---

### 2.2. Предлагаемое решение

1. **Мгновенный Guard-выход при активном выделении мышью:**
   - В начале `handleTypoMouseMove` и `handleEntityMouseMove` добавить проверку: если зажата левая кнопка мыши (`(event.buttons & 1) !== 0`) или активен флаг драга выделения, **немедленно прерывать выполнение**:
     ```javascript
     handleTypoMouseMove(event) {
       if ((event.buttons & 1) !== 0 || this.mobileSelectionDrag || this.isSelectingText) return;
       // ... остальная логика ховера
     }
     ```
   - Когда пользователь выделяет текст, система вообще не должна тратить ресурсы на поиски опечаток и всплывающих карточек под курсором.

2. **Перевод слоя выделения на DOM Recycling (Pool Pattern):**
   - Отказаться от `layer.innerHTML = ...` в `renderNocturneSelectionLayer()`.
   - Создать пулик элементов `<span class="nocturne-selection-rect">`. При изменении выделения менять только CSS-параметры существующим элементам: `el.style.transform = translate3d(...)` или `left/top/width/height`. Недостающие элементы досоздавать, лишние скрывать (`display: none`).

3. **Оптимизация структуры индекса опечаток $O(N) \to O(1)$:**
   - Превратить `typoMatchIndex` из плоского массива в структурированный `Map<blockId, Array<Match>>`. Поиск опечатки в `findTypoMatchAtPoint` будет происходить мгновенно только по опечаткам конкретного абзаца `blockId`, а не всего документа.

---

## 3. Исправление фундаментальных проблем Smart-словаря

### 3.1. Игнорирование первого клика по пункту контекстного меню

#### Доказательная база и техническая причина (Root Cause)
При нажатии правой кнопкой мыши по ошибке открывается контекстное меню `#app-context-menu`. Однако первый клик по любому пункту (например, «Добавить в словарь») игнорируется, и меню реагирует только на второй клик.

- **Где в коде:** [`src/main.js:3496`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L3496) (`handleGlobalPointerDownCapture`) и [`src/main.js:3539`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L3539) (`selectionchange`).
- **Механика сбоя:**
  1. Кнопки контекстного меню не предотвращают нативное поведение фокуса на фазе `pointerdown` / `mousedown`.
  2. Когда пользователь нажимает кнопку мыши на пункте меню, браузер перед событием `click` сначала генерирует событие `pointerdown`.
  3. Так как событие `pointerdown` переходит на элемент контекстного меню, фокус с текстового редактора `.page-content` сбрасывается (`blur` / `focusout`).
  4. Браузер сбрасывает DOM-выделение, из-за чего немедленно срабатывает глобальный слушатель `document.addEventListener('selectionchange', ...)` ([`src/main.js:3539`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L3539)).
  5. Внутри `selectionchange` вызывается `captureSelectionSnapshot()`, который видит пустое выделение и перезаписывает `this.state.contextMenu` или сбрасывает состояние меню.
  6. В результате, когда доли секунды спустя браузер генерирует событие `click`, функция `handleContextMenuAction` ([`src/main.js:6280`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L6280)) видит `const ctx = this.state.contextMenu; if (!ctx) return;` — **состояние уже сброшено**, и клик игнорируется!

#### Предлагаемое решение
1. **Перехват `pointerdown` / `mousedown` на контекстном меню:**
   - Для элемента `#app-context-menu` добавить слушатель `pointerdown` и `mousedown` с вызовом `event.preventDefault()`:
     ```javascript
     document.getElementById('app-context-menu')?.addEventListener('pointerdown', (e) => {
       e.preventDefault(); // Предотвращает утерю фокуса редактора и сброс selectionchange
     });
     ```
   - Это сохранит каретку, DOM-выделение и объект `this.state.contextMenu` нетронутыми в момент нажатия мыши, гарантируя 100% срабатывание действия с первого клика.

---

### 3.2. Фантомные «кликабельные» области в текстовом редакторе при включенном Smart-словаре

#### Доказательная база и техническая причина (Root Cause)
При включении режима Smart-словаря в редакторе появляются полусломанные области, на которых курсор мыши меняется на кликабельный (pointer / edit cursor), но клики по ним ничего не делают.

- **Где в коде:** [`src/main.js:10663-10707`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L10663-L10707) (`collectSmartTypoMatches`) и [`src/main.js:6070-6081`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L6070-L6081) (`renderTypoSvgOverlays`).
- **Механика сбоя:**
  1. **Устаревание диапазонов (Stale `Range` Objects):** Smart-speller отправляет слова на проверку в фоновом потоке/асинхронно (`scheduleSpellerCheck`, [`src/main.js:10596`](file:///d:/С%20диска%20С%20дампик/coding/today%20we%20steal%20the%20code%202/src/main.js#L10596)). Когда результат возвращается, он заносит объекты `Range` в `_typoHighlightRangesMap`.
  2. Если пользователь в этот момент редактирует текст, удаляет слова или переносит абзацы, старые объекты `Range` в памяти остаются привязанными к отсоединенным (detached) текстовым узлам DOM.
  3. В WebKit/Blink вызов `range.getBoundingClientRect()` на отсоединенном или частично удаленном `Range` возвращает прямоугольник с координатами `(left: 0, top: 0)` либо координаты старого места абзаца.
  4. Функция `renderTypoSvgOverlays` генерирует прозрачные или смещенные SVG-слои `.typo-svg-overlay`, а `findTypoMatchAtPoint` при движении мыши находит совпадение по старым офсетам в `typoMatchIndex`.
  5. В результате `handleTypoMouseMove` активирует класс `hovered` и меняет курсор мыши над **пустым местом**, где раньше было ошибочное слово. При клике же `applyTypoReplacement` не может найти исходный текст и ничего не делает.
  6. **Рассинхронизация смещений при наличии инлайн-тегов:** `textNodesForHighlightBlock` объединяет текст всех узлов в `fullText`. Если внутри абзаца есть инлайн-теги (например, `<span class="entity-link">` или элементы форматирования), индексы в `fullText` перестают совпадать с реальными смещениями DOM-текста. `rangeFromBlockOffsets` строит `Range`, захватывающий межтеговые пробелы и пустые области между словами.

#### Предлагаемое решение
1. **Строгая валидация привязки `Range` перед созданием ховера:**
   - В `findTypoMatchAtPoint` и `renderTypoSvgOverlays` добавить обязательную проверку активности и актуальности текстовых узлов диапазона:
     ```javascript
     const isRangeValid = (range) => {
       return range 
         && range.startContainer.isConnected 
         && range.endContainer.isConnected 
         && range.startContainer.ownerDocument.body.contains(range.startContainer);
     };
     ```
   - Если диапазон утерял связь с DOM, он немедленно удаляется из `_typoHighlightRangesMap` и `typoMatchIndex`, исключая создание фантомных областей.

2. **Синхронная инвалидация индекса опечаток при вводе текста:**
   - При любом редактировании DOM абзаца (`beforeinput` / `input`) мгновенно очищать совпадения `typoMatchIndex` для редактируемого `blockId`, не дожидаясь таймера debounced-обновления.

3. **Корректировка `rangeFromBlockOffsets` для инлайн-структур:**
   - Учитывать границы текстовых узлов при наличии элементов `.entity-link` и форматирования, чтобы `Range` строился строго внутри контейнеров слов, исключая захват пустых промежутков.

---

## 4. Сводная таблица найденных проблем и методов решения

| № | Компонент / Проблема | Точное место в коде | Коренная причина (Empirical Evidence) | Решение без изменения дизайна/анимаций |
|---|---|---|---|---|
| **1** | **Split-Screen lag карточек БЗ** | `src/main.js:16305` (`observeKbGridResize`), `ui.css:4870` | Forced Synchronous Layout (`getBoundingClientRect` в цикле `ResizeObserver`), избыточный FLIP для невидимых карточек, конфликт CSS Transition и `card.animate()` | CSS `contain: layout paint;`, фильтрация через `IntersectionObserver` (анимировать только visible), пакетирование чтения/записи RAF, выключение CSS transition во время FLIP |
| **2** | **Лаг кастомного выделения** | `src/main.js:3529` (`handleTypoMouseMove`), `src/main.js:5166` (`renderNocturneSelectionLayer`) | `caretRangeFromPoint` + $O(N)$ поиск по массиву опечаток на каждый пиксель `mousemove` при зажатом выделении + деструктивный `innerHTML` слоя выделения | Guard `(event.buttons & 1)` для отмены ховеров при драге мышью, DOM recycling (пул спанов) для слоя выделения, индекс опечаток за $O(1)$ через `Map<blockId, Match[]>` |
| **3.1**| **Smart-словарь: игнор 1-го клика в контекстном меню** | `src/main.js:3496` (`handleGlobalPointerDownCapture`), `src/main.js:6280` (`handleContextMenuAction`) | `pointerdown` по меню вызывает утерю фокуса редактором $\to$ `selectionchange` сбрасывает `this.state.contextMenu` до события `click` | `e.preventDefault()` на `pointerdown` элементов контекстного меню для сохранения фокуса и состояния выделения |
| **3.2**| **Smart-словарь: фантомные кликабельные зоны** | `src/main.js:6070` (`renderTypoSvgOverlays`), `src/main.js:10663` (`collectSmartTypoMatches`) | Устаревшие объекты `Range` на отсоединенных DOM-узлах возвращают `(0,0)` координаты + расхождение смещений `fullText` из-за инлайн-тегов | Проверка `isConnected` у `Range` перед созданием ховера, мгновенная инвалидация индекса блока при вводе, корректный учет инлайн-тегов в `rangeFromBlockOffsets` |
