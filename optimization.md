# Nocturne Writer — Руководство по оптимизации производительности

> **Для AI-агента**: это детальная инструкция по снижению нагрузки CPU (~30%) и GPU (~50%, 3D render).
> **ГЛАВНОЕ ПРАВИЛО**: визуал и работа приложения МЕНЯТЬСЯ НЕ ДОЛЖНЫ. Никаких видимых регрессий.
> **ОБЯЗАТЕЛЬНО**: перед началом работы — `git commit` текущего состояния.

---

## Диагноз

Приложение нагружает CPU на ~30% и GPU на ~50% (3D рендер) **даже в idle** (пользователь ничего не делает).
Выключение blur снижает, но не убирает GPU-нагрузку.

**Корневая причина** — цепная реакция:
```
rAF loop каретки (60fps) → forced reflow → layout invalidation → repaint →
→ backdrop-filter recomposite (GPU blur) → GPU 3D render
```

---

## Источники нагрузки (по приоритету)

### 🔴 #1. Бесконечный `requestAnimationFrame` loop каретки

**Файл**: `src/main.js`, метод `startCaretUpdateLoop()` (≈ строка 13180)
**Вызывается**: один раз при инициализации, строка 3419

```js
// ТЕКУЩИЙ КОД — проблема:
startCaretUpdateLoop() {
    if (this.caretLoopId) cancelAnimationFrame(this.caretLoopId);
    const loop = () => {
      if (document.hasFocus()) {
        this.updateCustomCaret(); // 60 раз/сек, ДАЖЕ В IDLE
      }
      this.caretLoopId = requestAnimationFrame(loop); // НИКОГДА не останавливается
    };
    this.caretLoopId = requestAnimationFrame(loop);
}
```

**Что делает `updateCustomCaret()` каждый кадр** (строки ~13123-13178):
1. `getSelection()` + `getRangeAt(0).cloneRange()`
2. `this.rangeRect(range)` → внутри `getBoundingClientRect()` × 2-3 + `getComputedStyle()` = **forced reflow**
3. `scrollContainer.getBoundingClientRect()` (строка 13153) — ещё reflow
4. Запись `caret.style.left/top/height` — **layout invalidation**
5. `caret.classList.toggle('inactive', ...)` — потенциальная style invalidation
6. `this.updateCursorLight(activeEditable)` (строки 12908-12926) — ещё `getBoundingClientRect()` × 2 + запись `light.style.left/top`

**Итого за один кадр**: ~5 forced reflow + style writes → repaint → GPU recomposite всех backdrop-filter слоёв.
**При 60fps**: 300 forced reflow/сек в idle.

#### Почему каретка реализована через rAF loop

Это не баг, а осознанное решение для борьбы с проблемами contenteditable:

1. **Нет нативного события для координат каретки** — `selectionchange` говорит что позиция изменилась, но не даёт экранные координаты.
2. **Баг фантомной каретки**: `Range.getBoundingClientRect()` на пустой строке после Enter часто возвращает координаты ПРЕДЫДУЩЕЙ строки до начала ввода. Для борьбы с этим есть fallback-методы: `softEmptyLineCaretRect` (строка 12938), `emptyBlockCaretRect` (строка 13080), `caretRectFromContext` (строка 12968).
3. **Программные изменения selection** (IME, автозамена, скрипты) не всегда генерируют `selectionchange`.

#### Как оптимизировать (задача для агента)

Заменить бесконечный rAF на **event-driven подход с throttle**:

```js
startCaretUpdateLoop() {
    if (this.caretLoopId) cancelAnimationFrame(this.caretLoopId);
    this._caretRafPending = false;

    const scheduleCaretUpdate = (doubleRaf = false) => {
      if (this._caretRafPending) return;
      this._caretRafPending = true;
      const doUpdate = () => {
        this._caretRafPending = false;
        if (document.hasFocus()) this.updateCustomCaret();
      };
      if (doubleRaf) {
        requestAnimationFrame(() => requestAnimationFrame(doUpdate));
      } else {
        requestAnimationFrame(doUpdate);
      }
    };

    // ВАЖНО: привязывать надо к document, НЕ к workspace-stage!
    // Предыдущая попытка привязки к workspace-stage убила titlebar Electron.
    document.addEventListener('selectionchange', () => scheduleCaretUpdate(), { passive: true });
    window.addEventListener('resize', () => scheduleCaretUpdate(), { passive: true });

    // Для scroll — привязать к конкретным scroll-контейнерам.
    // НО: они могут не существовать при инициализации!
    // Решение: использовать MutationObserver или привязывать при открытии документа.
    // Альтернатива: document-level scroll listener с capture:
    document.addEventListener('scroll', () => scheduleCaretUpdate(), { capture: true, passive: true });

    // Input events — doubleRaf чтобы дождаться reflow после Enter
    document.addEventListener('input', () => scheduleCaretUpdate(true), { passive: true });
    document.addEventListener('keyup', () => scheduleCaretUpdate(true), { passive: true });
    document.addEventListener('mouseup', () => scheduleCaretUpdate(), { passive: true });
    document.addEventListener('touchend', () => scheduleCaretUpdate(), { passive: true });
    document.addEventListener('focusin', () => scheduleCaretUpdate(), { passive: true });
    document.addEventListener('focusout', () => scheduleCaretUpdate(), { passive: true });

    // Начальное позиционирование
    scheduleCaretUpdate();
}
```

> ⚠️ **КРИТИЧЕСКОЕ ПРЕДУПРЕЖДЕНИЕ**: предыдущая попытка оптимизации **сломала Electron titlebar**.
> Причина: event listeners привязывались к `document.getElementById('workspace-stage') || document.body`,
> и при отсутствии workspace-stage fallback на body мог перехватывать/мешать titlebar событиям.
> **Решение**: привязывать ВСЕ listeners к `document` с `{ passive: true }`.
> Не привязывать к `document.body` или к конкретным элементам которые могут не существовать.

> ⚠️ **ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА ПОСЛЕ ИЗМЕНЕНИЯ**:
> 1. Запустить Electron: `npm run dev` + `npm run electron:dev`
> 2. Проверить что titlebar виден и кликабелен (minimize/maximize/close)
> 3. Проверить каретку: мигает, переходит на новую строку по Enter, cursor-light следует за кареткой
> 4. Проверить набор текста — нет задержек каретки
> 5. Проверить скролл — каретка прячется при уходе за viewport

**Ожидаемый эффект**: CPU -15-20%, GPU -15-25% в idle.

---

### 🔴 #2. `backdrop-filter: blur()` на постоянно видимых элементах

**Файлы**: `src/css/ui.css` (77+ деклараций), `src/css/experimental.css` (12+ деклараций)

`backdrop-filter: blur(Npx)` заставляет GPU каждый кадр:
1. Скопировать пиксели за элементом
2. Применить Gaussian blur (шейдерная операция = **3D рендер**)
3. Скомпоновать финальный кадр

**Постоянно видимые элементы с blur** (самые тяжёлые):

| Элемент | CSS файл | Строки ≈ | Blur radius |
|---------|----------|----------|-------------|
| `#sidebar`, `#pane-sidebar` | ui.css | 377-390 | `blur(28px) saturate(1.4)` |
| Workspace tabs | ui.css | ~652 | `blur(20px)` |
| Header/status bar | ui.css | ~2032 | `blur(18px) saturate(1.2)` |
| Bottom panels | ui.css | ~2516, ~2550 | `blur(18-22px)` |
| Experimental sidebar | experimental.css | ~222, ~292 | `blur(35-40px)` |
| Experimental page | experimental.css | ~373 | `blur(40px) saturate(160%)` |

#### Как оптимизировать

Для **постоянно видимых** элементов заменить `backdrop-filter: blur()` на `background` с повышенной непрозрачностью:

```css
/* БЫЛО: */
#sidebar {
  backdrop-filter: blur(28px) saturate(1.4);
  background: rgba(12, 12, 20, 0.6);
}

/* СТАЛО: */
#sidebar {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: rgba(12, 12, 20, 0.93);
}
```

**ОСТАВИТЬ** backdrop-filter на: модалках, поповерах, контекстных меню, тултипах — они временные.

**ВАЖНО**: Проверить что стиль `.blur-disabled` / `.no-blur` (если есть в настройках) продолжает работать. Grep по `blur-disabled` и `no-blur` в CSS и JS.

**Ожидаемый эффект**: GPU -15-20%.

---

### 🟠 #3. Ambient Orbs с `filter: blur(160px)` + бесконечная анимация

**Файл**: `src/css/experimental.css`, строки 126-159

```css
body.theme-experimental::before,
body.theme-experimental::after {
  width: 50vw;        /* ОГРОМНЫЙ */
  height: 50vw;
  filter: blur(160px); /* ТЯЖЕЛЕЙШИЙ blur */
  opacity: 0.12;
  animation: ambient-orb-swim 25s infinite alternate ease-in-out;
  /* ^ бесконечная анимация = GPU перерисовка каждый кадр */
}
```

**ЛОВУШКА**: `body.theme-experimental::before` **переопределяется** ниже (строка ~162) для noise overlay! Там полностью другой элемент с `inset: 0`, `background-image: url(...)`. Если трогать `::before` — noise overlay сломается.

#### Как оптимизировать

**Вариант A** (безопасный): убрать `animation`, оставить статичные орбы
```css
body.theme-experimental::before,
body.theme-experimental::after {
  /* ...всё то же, но: */
  animation: none;
  transform: translate(5vw, 10vh) scale(1.05);
}
body.theme-experimental::after {
  animation: none;
  animation-delay: unset;
  transform: translate(-3vw, 12vh) scale(0.95);
}
```

**Вариант B** (радикальный): заменить pseudo-elements на статический `background` на body
```css
body.theme-experimental {
  background: 
    radial-gradient(ellipse at 15% 20%, rgba(var(--accent-rgb), 0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 80%, rgba(var(--accent-rgb), 0.05) 0%, transparent 50%),
    #030306 !important;
}
```

**ВНИМАНИЕ**: при любом варианте — НЕ ТРОГАТЬ строки 161-171 (noise overlay через `::before`).

**Ожидаемый эффект**: GPU -10-15%.

---

### 🟡 #4. Cursor-light `filter: blur(4px)` в experimental теме

**Файл**: `src/css/experimental.css`, строка ~408

```css
.theme-experimental .cursor-light {
  filter: blur(4px) !important; /* blur на маленьком элементе — лишние GPU циклы */
}
```

**Решение**: убрать `filter: blur(4px)`, компенсировать увеличением размера gradient:

```css
.theme-experimental .cursor-light {
  /* filter: blur(4px) убран */
  width: 100px !important;  /* было 90px */
  height: 100px !important;
  background: radial-gradient(circle, 
    rgba(var(--accent-rgb, 139, 92, 246), 0.28) 0%, 
    rgba(var(--accent-rgb, 139, 92, 246), 0.06) 45%, 
    transparent 72%) !important;
}
```

**Ожидаемый эффект**: GPU -5-8%.

---

### 🟡 #5. `will-change` на 13 элементах + `transition: all` на 22 элементах

**Файлы**: `src/css/ui.css`, `src/css/experimental.css`

- Каждый `will-change: transform` создаёт **отдельный GPU compositing layer** = расход VRAM
- `transition: all` заставляет браузер отслеживать **все** CSS-свойства для анимации

**Что делать**:

1. Grep `will-change` в `src/css/` → удалить со всех элементов которые не анимируются активно
2. Grep `transition: all` в `src/css/` → заменить на конкретные свойства. Для каждого элемента посмотреть какие свойства реально меняются на `:hover`/`:focus`:

```css
/* БЫЛО: */
transition: all 0.2s ease;

/* СТАЛО (пример для кнопки): */
transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease;
```

**Ожидаемый эффект**: CPU -2-3%, GPU -3-5%.

---

### 🟡 #6. Анимация `caret-breath` с box-shadow

**Файлы**: 
- `src/css/animations.css`, строка 49: `@keyframes caret-breath`
- `src/css/ui.css`, строка 1637: `.custom-caret.breath`
- `src/css/experimental.css`, строки 174-187: override для experimental

Анимация бесконечно меняет `box-shadow: 0 0 8px → 0 0 24px` — GPU blur пересчёт каждый кадр.

**Решение**: заменить анимированный box-shadow на анимированный opacity псевдоэлемента:

```css
.custom-caret {
  /* Убрать box-shadow: 0 0 16px var(--accent-glow); из базового стиля */
  /* Вместо него: */
}
.custom-caret::after {
  content: '';
  position: absolute;
  inset: -10px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
  opacity: 0.3;
  pointer-events: none;
}
@keyframes caret-breath {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.custom-caret.breath::after {
  animation: caret-breath 1.8s ease-in-out infinite;
}
```

**ОСТОРОЖНО**: не сломать `.custom-caret.block` (width: 10px, mix-blend-mode: difference) и `.custom-caret.underline`.

**Ожидаемый эффект**: GPU -3-5%.

---

## Порядок выполнения

| # | Задача | Влияние | Риск | Примечания |
|---|--------|---------|------|------------|
| 1 | Event-driven каретка | 🔴🔴🔴 | ⚠️ Средний | Читай предупреждение про titlebar! |
| 2 | Lazy backdrop-filter | 🔴🔴 | ✅ Низкий | Только постоянно видимые элементы |
| 3 | Статические Ambient Orbs | 🟠🟠 | ⚠️ Не трогать noise overlay! | Строки 161-171 |
| 4 | Cursor-light blur | 🟡 | ✅ Низкий | Одна строка |
| 5 | will-change / transition:all | 🟡 | ✅ Низкий | Grep + замена |
| 6 | caret-breath box-shadow | 🟡 | ⚠️ Средний | Не сломать block/underline стили |

**Делать git commit после КАЖДОЙ оптимизации. Тестировать после каждой.**

---

## Что НЕ трогать

- Particles/confetti анимации — одноразовые, не влияют на idle
- `src/core/db.js` — не связано
- `src/editor/nocturne-editor.js` — typewriter scroll rAF завершается сам, не бесконечный
- Модальные backdrop-filter — временные элементы
- Логику позиционирования каретки (методы `rangeRect`, `softEmptyLineCaretRect` и т.д.) — только КОГДА вызывать, не ЧТО вызывать
