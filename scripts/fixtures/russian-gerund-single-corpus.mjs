const gerunds = [
  'Улыбаясь', 'Оглянувшись', 'Задумавшись', 'Подумав', 'Приглядевшись', 'Проснувшись',
  'Успокоившись', 'Устав', 'Раздевшись', 'Обрадовавшись', 'Рассердившись', 'Удивившись',
  'Растерявшись', 'Умывшись', 'Засмеявшись', 'Нахмурившись', 'Попрощавшись', 'Остановившись',
  'Наклонившись', 'Отдохнув', 'Споткнувшись', 'Приблизившись', 'Заслушавшись', 'Засмотревшись',
];
const contexts = ['', 'Ранее он задумался. ', '— ', '🙂 '];
export const RUSSIAN_GERUND_SINGLE_CASES = gerunds.flatMap((gerund, index) => {
  const lower = gerund.toLowerCase();
  return [
    { position: 'initial', text: `${gerund} он открыл дверь.`, gold: `${gerund}, он открыл дверь.` },
    { position: 'medial', text: `Он ${lower} открыл дверь.`, gold: `Он, ${lower}, открыл дверь.` },
  ].flatMap(item => contexts.map((prefix, context) => ({ id: `ru-single-gerund-${index + 1}-${item.position}-${context}`, position: item.position, text: prefix + item.text, gold: prefix + item.gold })));
});
