const cases = [];
const capitalize = text => text[0].toUpperCase() + text.slice(1);
const adjectives = {
  ru: [['белый', 'белая', 'белое'], ['маленький', 'маленькая', 'маленькое'], ['красивый', 'красивая', 'красивое'], ['тихий', 'тихая', 'тихое'], ['тёмный', 'тёмная', 'тёмное'], ['огромный', 'огромная', 'огромное']],
  uk: [['білий', 'біла', 'біле'], ['маленький', 'маленька', 'маленьке'], ['гарний', 'гарна', 'гарне'], ['тихий', 'тиха', 'тихе'], ['темний', 'темна', 'темне'], ['великий', 'велика', 'велике']],
};
const nouns = {
  ru: { f: ['машина', 'комната', 'дорога', 'сестра', 'деревня', 'семья', 'девушка', 'газета', 'дверь', 'ночь'], m: ['город', 'мост', 'стул', 'сад', 'брат', 'человек', 'дом', 'ветер'], n: ['море', 'поле', 'солнце', 'озеро', 'здание', 'дерево', 'место'] },
  uk: { f: ['машина', 'кімната', 'дорога', 'сестра', 'газета', 'ніч', 'вулиця', 'родина', 'дівчина'], m: ['міст', 'сад', 'брат', 'вітер', 'стілець', 'будинок', 'чоловік'], n: ['море', 'поле', 'сонце', 'озеро', 'дерево', 'місце'] },
};
for (const lang of ['ru', 'uk']) for (const forms of adjectives[lang]) for (const [gender, words] of Object.entries(nouns[lang])) for (const noun of words) {
  const index = { m: 0, f: 1, n: 2 }[gender], gold = `${capitalize(forms[index])} ${noun}.`;
  cases.push({ lang, text: gold, gold: [], expected: 'no-error' });
  if (gender !== 'm') cases.push({ lang, text: `${capitalize(forms[0])} ${noun}.`, gold: [gold], expected: 'correction' });
}
const verbs = [['cook', 'cooks'], ['sing', 'sings'], ['swim', 'swims'], ['travel', 'travels'], ['sleep', 'sleeps'], ['wash', 'washes'], ['fly', 'flies'], ['cry', 'cries'], ['carry', 'carries'], ['teach', 'teaches'], ['watch', 'watches'], ['dance', 'dances'], ['finish', 'finishes'], ['catch', 'catches'], ['mix', 'mixes'], ['kiss', 'kisses']];
for (const [plain, singular] of verbs) for (const subject of ['He', 'She', 'It', 'They', 'We', 'You']) {
  const correct = ['He', 'She', 'It'].includes(subject) ? singular : plain, wrong = correct === plain ? singular : plain;
  const gold = `${subject} ${correct} every day.`;
  cases.push({ lang: 'en', text: `${subject} ${wrong} every day.`, gold: [gold], expected: 'correction' });
  cases.push({ lang: 'en', text: gold, gold: [], expected: 'no-error' });
}
const negatives = {
  ru: ['Она видела новый дом.', 'Он купил новое платье.', 'Мы гуляли по дороге.', 'Он понял что угодно.', 'Она сказала: «Нет, нет».', 'Он оплатил проезд.', 'Она прочитала письмо...', 'Я скучаю по тебе.', 'Мы знаем, что он здесь.', 'Новый адрес указан в письме.', 'Этот город красивый.', 'В комнате тихо.'],
  uk: ['Вона бачила новий будинок.', 'Він купив нове пальто.', 'Ми гуляли дорогою.', 'Він сказав що завгодно.', 'Вона сказала: «Ні, ні».', 'Ми брали участь у виставі.', 'Він прочитав лист...', 'Згідно з наказом ми пішли.', 'Ми знаємо, що він тут.', 'Нову адресу вказано в листі.', 'Який чудовий день!', 'У кімнаті тихо.'],
  en: ['They had had enough.', 'I knew that that was true.', 'What it is is unclear.', 'However difficult it is, she succeeds.', 'He read the letter yesterday.', 'The address is correct.', 'I am here.', 'You are here.', 'They were here.', 'She has a book.', 'He can swim.', 'I saw a European city.', 'She wore a uniform.', 'He waited for an hour.', 'I saw a useful tool.', 'No, no, she said.', 'She opened the door...', 'She is interested in music.'],
};
for (const [lang, texts] of Object.entries(negatives)) for (const text of texts) cases.push({ lang, text, gold: [], expected: 'no-error' });
for (const item of [...cases].filter(item => item.expected === 'correction')) cases.push({ ...item, text: item.text[0].toLowerCase() + item.text.slice(1) });
export const LANGUAGE_QUALITY_HOLDOUT = cases.map((item, index) => ({ ...item, id: `holdout-${index + 1}` }));
