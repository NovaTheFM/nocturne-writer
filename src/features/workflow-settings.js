import { escapeHtml } from '../core/utils.js';

export const workflowDefaults = {
  historyOpenMode: 'text', historyAutoGrowth: true, historyGrowthPages: 5, historyPageChars: 1800,
  historyAutoLargeEdit: true, historyBulkSentences: 5, historyBulkChars: 500,
  historyAutoTimer: true, historyTimerMinutes: 30, historyIdleSeconds: 60, historyTimerKeep: 5,
  historyLimitMB: 50, historyRestoreNotes: false, historyRestoreBookmarks: true,
  manuscriptSearchMode: 'phrase', searchFoldYo: false, searchInflections: false, searchAliases: false,
  searchResultsMode: 'return', searchFilterFirst: 'all', searchShowAll: false,
  aiContextMode: 'automatic', aiResultLocation: 'chapter',
};

export const workflowSettings = [
  { tab: 'history', key: 'historyOpenMode', label: 'Открывать версию', note: 'Первый экран после выбора сохранённой версии.', type: 'select', options: [['text', 'Просмотр текста'], ['compare', 'Сравнение'], ['copy', 'Отдельная копия главы']] },
  { tab: 'history', key: 'timeMachine', label: 'Автоматическая история', note: 'Фоновые версии по включённым ниже условиям. Ручные версии доступны всегда.', type: 'toggle' },
  { tab: 'history', key: 'historyAutoGrowth', label: 'Версия при росте текста', note: 'Сохраняет версию после добавления заданного объёма. Размер шрифта и пагинация на порог не влияют.', type: 'toggle' },
  { tab: 'history', key: 'historyGrowthPages', label: 'Объём роста', note: 'Число условных страниц между версиями.', type: 'range', min: 1, max: 30, suffix: ' стр.' },
  { tab: 'history', key: 'historyPageChars', label: 'Символов на условной странице', note: 'По умолчанию 1800: пять страниц соответствуют 9000 символам.', type: 'range', min: 500, max: 4000, step: 100 },
  { tab: 'history', key: 'historyAutoLargeEdit', label: 'Перед большой вставкой или удалением', note: 'Сохраняет исходный текст, когда изменён большой фрагмент.', type: 'toggle' },
  { tab: 'history', key: 'historyBulkSentences', label: 'Порог в предложениях', note: 'Версия создаётся, если вставленный или удалённый фрагмент достигает этого числа предложений.', type: 'range', min: 2, max: 30 },
  { tab: 'history', key: 'historyBulkChars', label: 'Порог в символах', note: 'Дополнительный порог для длинных фрагментов без точек. Достаточно любого из двух порогов.', type: 'range', min: 100, max: 10000, step: 100 },
  { tab: 'history', key: 'historyAutoTimer', label: 'Версия по времени работы', note: 'Считает активную работу в открытом документе; время в фоне и длительные паузы не учитываются.', type: 'toggle' },
  { tab: 'history', key: 'historyTimerMinutes', label: 'Интервал активной работы', note: 'Каждые полчаса по умолчанию.', type: 'range', min: 1, max: 120, suffix: ' мин' },
  { tab: 'history', key: 'historyIdleSeconds', label: 'Пауза до остановки счётчика', note: 'Без новых действий в редакторе отсчёт активной работы останавливается.', type: 'range', min: 15, max: 300, step: 15, suffix: ' с' },
  { tab: 'history', key: 'historyTimerKeep', label: 'Хранить версий по таймеру', note: 'Удаляются только старые версии по таймеру. Ручные, закреплённые и версии больших правок остаются.', type: 'range', min: 1, max: 50 },
  { tab: 'history', key: 'historyLimitMB', label: 'Предупреждать о размере истории', note: 'При превышении лимита покажем сообщение после паузы в письме. История автоматически не удаляется.', type: 'range', min: 1, max: 500, suffix: ' МБ' },
  { tab: 'history', key: 'historyRestoreNotes', label: 'Выбирать заметки главы при восстановлении', note: 'Начальное состояние галочки; его можно изменить перед каждым восстановлением.', type: 'toggle' },
  { tab: 'history', key: 'historyRestoreBookmarks', label: 'Выбирать закладки при восстановлении', note: 'Начальное состояние галочки. Общие заметки всегда требуют отдельного выбора.', type: 'toggle' },
  { tab: 'manuscript-search', key: 'manuscriptSearchMode', label: 'Как искать несколько слов', note: 'Выбор «В документе / По всем рукописям» остаётся прежним. Точная фраза сохраняет привычное поведение.', type: 'select', options: [['phrase', 'Точная фраза'], ['all', 'Все слова в любом порядке'], ['any', 'Любое из слов']] },
  { tab: 'manuscript-search', key: 'searchFoldYo', label: 'Считать е и ё одинаковыми', note: 'Поиск «елка» найдёт «ёлка». Замена текста продолжает учитывать точное написание.', type: 'toggle' },
  { tab: 'manuscript-search', key: 'searchInflections', label: 'Искать словоформы', note: 'Дополнительно сопоставляет распространённые русские окончания. Это приближённый поиск; точная фраза доступна отдельно.', type: 'toggle' },
  { tab: 'manuscript-search', key: 'searchAliases', label: 'Искать псевдонимы', note: 'Учитывает имена, псевдонимы и формы упоминания из базы знаний.', type: 'toggle' },
  { tab: 'manuscript-search', key: 'searchResultsMode', label: 'После открытия найденного текста', note: 'На телефоне сохраняем запрос и положение списка для возврата. Панель рядом с текстом доступна на ПК.', type: 'select', options: [['return', 'Закрывать, с возможностью вернуться'], ['side', 'Оставлять рядом с текстом на ПК']] },
  { tab: 'manuscript-search', key: 'searchFilterFirst', label: 'Первый фильтр результатов', note: 'Определяет порядок фильтров; выбранная область не сужается автоматически.', type: 'select', options: [['all', 'Всегда показывать всё'], ['work', 'Произведение'], ['chapter', 'Глава'], ['type', 'Тип материала'], ['status', 'Статус главы']] },
  { tab: 'manuscript-search', key: 'searchShowAll', label: 'Всегда показывать все совпадения', note: 'Выключено: первые фрагменты и кнопка «Показать ещё». Включено: полный список.', type: 'toggle' },
  { tab: 'ai', key: 'aiContextMode', label: 'Подбор сведений для ИИ', note: 'Автоматический подбор можно поправить в окне контекста. Ручной выбор и сохранённые наборы доступны там же.', type: 'select', options: [['automatic', 'Автоматически, с моими уточнениями'], ['manual', 'Выбирать вручную'], ['preset', 'Сохранённый набор']] },
  { tab: 'ai', key: 'aiResultLocation', label: 'Где находить готовый ответ', note: 'Каждый ответ сохраняется. При смене главы исходный текст остаётся без изменений.', type: 'select', options: [['chapter', 'В правках исходной главы'], ['history', 'В истории запросов'], ['notification', 'Уведомление и история для возврата']] },
];

export function validateWorkflowSettings(settings) {
  for (const item of workflowSettings) {
    if (item.type === 'toggle') settings[item.key] = !!settings[item.key];
    if (item.type === 'range') {
      const value = Number(settings[item.key]);
      settings[item.key] = Number.isFinite(value) ? Math.max(item.min, Math.min(item.max, Math.round(value / (item.step || 1)) * (item.step || 1))) : workflowDefaults[item.key];
    }
    if (item.type === 'select' && !item.options.some(([value]) => value === settings[item.key])) settings[item.key] = workflowDefaults[item.key];
  }
  return settings;
}

export function workflowSettingsContent(app, tab) {
  const settings = app.state.settings;
  return workflowSettings.filter(item => item.tab === tab).map(item => {
    let control = '';
    if (item.type === 'select') control = app.renderSettingsSelect(item.key, item.options).replace('data-setting-select-toggle ', `data-setting-select-toggle aria-label="${escapeHtml(item.label)}" `);
    if (item.type === 'toggle') control = `<button type="button" class="toggle ${settings[item.key] ? 'on' : ''}" data-setting="${item.key}" data-kind="toggle" role="switch" aria-label="${escapeHtml(item.label)}" aria-checked="${!!settings[item.key]}"></button>`;
    if (item.type === 'range') control = `<div class="range-field" data-range-field><input class="range-control" type="range" min="${item.min}" max="${item.max}" step="${item.step || 1}" value="${settings[item.key]}" data-setting="${item.key}" data-suffix="${escapeHtml(item.suffix || '')}" aria-label="${escapeHtml(item.label)}"><input class="range-value-input" type="text" inputmode="numeric" value="${settings[item.key]}${escapeHtml(item.suffix || '')}" data-setting-input="${item.key}" data-suffix="${escapeHtml(item.suffix || '')}" data-min="${item.min}" data-max="${item.max}" data-step="${item.step || 1}" aria-label="${escapeHtml(item.label)}: значение"></div>`;
    return `<div class="setting-row"><div class="setting-info"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.note)}</small></div><div class="setting-control">${control}</div></div>`;
  }).join('');
}
