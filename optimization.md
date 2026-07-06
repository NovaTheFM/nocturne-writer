# Nocturne Writer — Optimization Guide

> Этот документ — инструкция для AI-агента по оптимизации производительности.  
> **ПРАВИЛО**: визуал и работа приложения МЕНЯТЬСЯ НЕ ДОЛЖНЫ.

---

## Что уже сделано ✅

### Оптимизация #1: Event-driven каретка (ПРИМЕНЕНА)

**Файл**: `src/main.js` → метод `startCaretUpdateLoop()` (≈ строка 13180)

Бесконечный `requestAnimationFrame` loop заменён на event-driven подход:
- `selectionchange`, `scroll`, `input`, `keyup`, `mouseup`, `touchend`, `focus`, `blur`, `resize` → одноразовый rAF
- `input` / `keyup` используют двойной rAF (чтобы дождаться reflow после Enter/paste — борьба с «фантомной кареткой»)
- Coalescing через флаг `_caretRafPending` — не более 1 обновления за кадр

**Ожидаемый эффект**: CPU -15-20%, GPU -15-25% в idle.

---

## Что нужно сделать 🔧

### Оптимизация #2: Lazy backdrop-filter для постоянно видимых элементов

**Проблема**: 77+ деклараций `backdrop-filter: blur(...)` в CSS. Элементы с backdrop-filter, которые **постоянно видимы на экране** (sidebar, tabs, header), заставляют GPU пересчитывать blur при каждом repaint.

**Файлы для изменения**:
- `src/css/ui.css` — основные стили
- `src/css/experimental.css` — экспериментальная тема

**Что делать**:

1. Найти все `backdrop-filter` на **постоянно видимых** элементах:
   - `#sidebar`, `#pane-sidebar` — `blur(28px) saturate(1.4)` (строки ~377-390 ui.css)
   - Workspace tabs area — `blur(18px)` 
   - Page header/status bar — `blur(18px) saturate(1.2)`
   - Bottom panels — `blur(20-24px)`

2. Заменить backdrop-filter на полупрозрачный фон **без blur**:
   ```css
   /* БЫЛО: */
   backdrop-filter: blur(28px) saturate(1.4);
   background: rgba(12, 12, 20, 0.6);
   
   /* СТАЛО: */
   backdrop-filter: none;
   background: rgba(12, 12, 20, 0.92); /* увеличить непрозрачность для компенсации */
   ```

3. **ОСТАВИТЬ** backdrop-filter на **временных** элементах (модалки, поповеры, контекстные меню) — они показываются ненадолго.

4. Убедиться что `.blur-disabled` класс (если есть переключатель блюра в настройках) продолжает работать.

**Ожидаемый эффект**: GPU -15-20%.

---

### Оптимизация #3: Статические Ambient Orbs

**Проблема**: Два pseudo-элемента `body.theme-experimental::before/::after` размером 50vw × 50vw с `filter: blur(160px)` и бесконечной CSS-анимацией `ambient-orb-swim`.

**Файл**: `src/css/experimental.css`, строки 126-159

**Что делать**:

1. Удалить `animation: ambient-orb-swim ...` с обоих pseudo-элементов
2. Оставить их как **статические** градиенты (opacity 0.12 + blur 160px = и так неразличимое пятно)
3. Задать им фиксированные позиции (выбрать позицию из середины анимации: примерно `transform: translate(5vw, 10vh) scale(1.1)`)

```css
/* БЫЛО: */
body.theme-experimental::before,
body.theme-experimental::after {
  /* ... */
  animation: ambient-orb-swim 25s infinite alternate ease-in-out;
}

/* СТАЛО: */
body.theme-experimental::before,
body.theme-experimental::after {
  /* ... всё то же, но без animation */
  transform: translate(5vw, 10vh) scale(1.05);
}
body.theme-experimental::after {
  transform: translate(-3vw, 12vh) scale(0.95);
}
```

**ВНИМАНИЕ**: `body.theme-experimental::before` переопределяется ниже (строка ~162) для noise overlay. Проверить что noise overlay НЕ сломался — он перекрывает первый pseudo-element.

**Ожидаемый эффект**: GPU -10-15%.

---

### Оптимизация #4: Cursor-light — убрать из rAF, привязать к событиям

**Проблема**: `updateCursorLight()` вызывается из `updateCustomCaret()` каждый раз → но теперь это event-driven, так что уже лучше. Дополнительно можно:

**Файл**: `src/css/experimental.css`, строка ~408

**Что делать**:
1. Убрать `filter: blur(4px)` с `.theme-experimental .cursor-light` — маленький элемент, blur не стоит GPU-цикла
2. Компенсировать визуально: увеличить размер gradientа или снизить opacity

```css
/* БЫЛО: */
.theme-experimental .cursor-light {
  filter: blur(4px) !important;
}

/* СТАЛО: */
.theme-experimental .cursor-light {
  /* filter: blur(4px) убран для производительности */
}
```

**Ожидаемый эффект**: GPU -5-8%.

---

### Оптимизация #5: Очистка `will-change` и `transition: all`

**Проблема**:
- 13 деклараций `will-change` создают отдельные GPU compositing layers
- 22 декларации `transition: all` заставляют браузер отслеживать все свойства

**Файлы**: `src/css/ui.css`, `src/css/experimental.css`

**Что делать**:

1. Найти все `will-change` (grep `will-change` в `src/css/`):
   - Оставить `will-change` ТОЛЬКО на элементах, которые реально анимируются часто (каретка, модалки при открытии)
   - Удалить с элементов которые просто «на всякий случай» (карточки, панели)

2. Заменить `transition: all` на конкретные свойства:
   ```css
   /* БЫЛО: */
   transition: all 0.2s ease;
   
   /* СТАЛО: */
   transition: background 0.2s ease, color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
   ```
   При замене — смотреть какие свойства реально меняются на `:hover`/`:focus` у данного элемента.

**Ожидаемый эффект**: CPU -2-3%, GPU -3-5%.

---

### Оптимизация #6: Анимация `caret-breath` — box-shadow → opacity

**Проблема**: `.custom-caret.breath` использует бесконечную анимацию с `box-shadow: 0 0 24px` — GPU пересчитывает blur каждый кадр.

**Файлы**: 
- `src/css/animations.css`, строка 49
- `src/css/ui.css`, строка 1637
- `src/css/experimental.css`, строка 174-187

**Что делать**:

1. Добавить pseudo-element `::after` на `.custom-caret` с заранее отрисованным glow (static box-shadow)
2. Анимировать только `opacity` этого pseudo-element вместо анимации box-shadow

```css
/* БЫЛО: */
@keyframes caret-breath {
  0%, 100% { box-shadow: 0 0 8px var(--accent-glow); }
  50% { box-shadow: 0 0 24px var(--accent); }
}

/* СТАЛО: */
.custom-caret::after {
  content: '';
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--accent-glow) 0%, transparent 70%);
  opacity: 0;
  pointer-events: none;
}
@keyframes caret-breath {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}
.custom-caret.breath::after {
  animation: caret-breath 1.8s ease-in-out infinite;
}
/* Убрать box-shadow из основной анимации каретки */
```

**ВАЖНО**: Не сломать стили `.custom-caret.block` и `.custom-caret.underline` — они имеют свои box-shadow.

**Ожидаемый эффект**: GPU -3-5%.

---

## 📋 Порядок выполнения (по приоритету)

| # | Задача | GPU эффект | Сложность | Риск |
|---|--------|-----------|-----------|------|
| ✅ | Event-driven каретка | -15-25% | Средняя | Средний |
| 2 | Lazy backdrop-filter | -15-20% | Низкая | Низкий |
| 3 | Статические Ambient Orbs | -10-15% | Низкая | Низкий |
| 4 | Cursor-light blur | -5-8% | Низкая | Минимальный |
| 5 | will-change / transition:all | -3-5% | Низкая | Минимальный |
| 6 | caret-breath box-shadow | -3-5% | Средняя | Средний |

## ⚠️ Абсолютные правила

1. **Визуал не должен измениться** — пользователь не должен заметить разницу
2. **Функционал не должен измениться** — каретка, выделение, blur в модалках — всё должно работать
3. **Тестировать после каждой оптимизации** — запуск `npm run dev`, проверка каретки, набора текста, переключения документов
4. **Делать git commit перед КАЖДОЙ оптимизацией**
5. **Не трогать particles/confetti** — они одноразовые и не влияют на idle
