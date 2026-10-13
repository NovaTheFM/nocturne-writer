import { SMART_DICTIONARY_CORPUS } from './smart-dictionary-corpus.mjs';

const mistakes = SMART_DICTIONARY_CORPUS.filter(item => item.expected === 'correction' && item.lang !== 'auto');
const families = {
  ru: [
    ['grammar', ['Она купил хлеб.', 'Она купила хлеб.'], ['Она прочитал письмо.', 'Она прочитала письмо.'], ['Она открыл окно.', 'Она открыла окно.'], ['Она написал ответ.', 'Она написала ответ.']],
    ['grammar', ['Он пришла домой.', 'Он пришёл домой.'], ['Он прочитала письмо.', 'Он прочитал письмо.'], ['Он открыла окно.', 'Он открыл окно.'], ['Он написала ответ.', 'Он написал ответ.']],
    ['grammar', ['Мы живёт у реки.', 'Мы живём у реки.'], ['Мы читает книгу.', 'Мы читаем книгу.'], ['Мы пишет письмо.', 'Мы пишем письмо.'], ['Мы играет во дворе.', 'Мы играем во дворе.']],
    ['grammar', ['Дети играет во дворе.', 'Дети играют во дворе.'], ['Дети читает книгу.', 'Дети читают книгу.'], ['Дети гуляет во дворе.', 'Дети гуляют во дворе.'], ['Дети живёт у реки.', 'Дети живут у реки.']],
    ['grammar', ['Это моя новый книга.', 'Это моя новая книга.'], ['Это моя старый тетрадь.', 'Это моя старая тетрадь.'], ['Это моя первый работа.', 'Это моя первая работа.'], ['Это моя последний попытка.', 'Это моя последняя попытка.']],
    ['grammar', ['Эти книга лежат на столе.', 'Эти книги лежат на столе.'], ['Эти окно были открыты.', 'Эти окна были открыты.'], ['Эти письмо лежат на столе.', 'Эти письма лежат на столе.'], ['Эти кошка спят.', 'Эти кошки спят.']],
    ['grammar', ['Согласно приказа мы ушли.', 'Согласно приказу мы ушли.'], ['Согласно плана мы ушли.', 'Согласно плану мы ушли.'], ['Согласно договора мы ушли.', 'Согласно договору мы ушли.'], ['Согласно закона мы ушли.', 'Согласно закону мы ушли.']],
    ['grammar', ['Я скучаю за тобой.', 'Я скучаю по тебе.'], ['Я скучаю за ним.', 'Я скучаю по нему.'], ['Я скучаю за ней.', 'Я скучаю по ней.'], ['Я скучаю за вами.', 'Я скучаю по вам.']],
    ['punctuation', ['Я знаю что он вернётся.', 'Я знаю, что он вернётся.'], ['Она сказала что придёт.', 'Она сказала, что придёт.'], ['Я думаю что всё получится.', 'Я думаю, что всё получится.'], ['Он понял что ошибся.', 'Он понял, что ошибся.']],
    ['punctuation', ['Когда стемнело мы вернулись.', 'Когда стемнело, мы вернулись.'], ['Когда рассвело мы вернулись.', 'Когда рассвело, мы вернулись.'], ['Когда потеплело мы вернулись.', 'Когда потеплело, мы вернулись.'], ['Когда похолодало мы вернулись.', 'Когда похолодало, мы вернулись.']],
    ['punctuation', ['Это дом который построил мой отец.', 'Это дом, который построил мой отец.'], ['Это книга которую я прочитал.', 'Это книга, которую я прочитал.'], ['Это письмо которое я получил.', 'Это письмо, которое я получил.'], ['Это люди которые нам помогли.', 'Это люди, которые нам помогли.']],
    ['punctuation', ['Привет,мир!', 'Привет, мир!'], ['Да,конечно.', 'Да, конечно.'], ['Нет,спасибо.', 'Нет, спасибо.'], ['Я увидел его,и улыбнулся.', 'Я увидел его, и улыбнулся.']],
    ['punctuation', ['Она пришла,, а он ушёл.', 'Она пришла, а он ушёл.'], ['Мы вернулись,, а они ушли.', 'Мы вернулись, а они ушли.'], ['Он знал ответ , но молчал.', 'Он знал ответ, но молчал.'], ['Она открыла окно , но промолчала.', 'Она открыла окно, но промолчала.']],
    ['capitalization', ['мы вернулись домой.', 'Мы вернулись домой.'], ['она открыла дверь.', 'Она открыла дверь.'], ['он приехал в москву.', 'Он приехал в Москву.'], ['она приехала в киев.', 'Она приехала в Киев.']],
    ['repetition', ['Она открыла открыла дверь.', 'Она открыла дверь.'], ['Он прочитал прочитал письмо.', 'Он прочитал письмо.'], ['Мы увидели увидели дом.', 'Мы увидели дом.'], ['Они закрыли закрыли окно.', 'Они закрыли окно.']],
  ],
  uk: [
    ['grammar', ['Вона купив хліб.', 'Вона купила хліб.'], ['Вона прочитав лист.', 'Вона прочитала лист.'], ['Вона відкрив вікно.', 'Вона відкрила вікно.'], ['Вона написав відповідь.', 'Вона написала відповідь.']],
    ['grammar', ['Він прийшла додому.', 'Він прийшов додому.'], ['Він прочитала лист.', 'Він прочитав лист.'], ['Він відкрила вікно.', 'Він відкрив вікно.'], ['Він написала відповідь.', 'Він написав відповідь.']],
    ['grammar', ['Ми живе біля річки.', 'Ми живемо біля річки.'], ['Ми читає книгу.', 'Ми читаємо книгу.'], ['Ми пише лист.', 'Ми пишемо лист.'], ['Ми грає у дворі.', 'Ми граємо у дворі.']],
    ['grammar', ['Діти грає у дворі.', 'Діти грають у дворі.'], ['Діти читає книгу.', 'Діти читають книгу.'], ['Діти гуляє у дворі.', 'Діти гуляють у дворі.'], ['Діти живе біля річки.', 'Діти живуть біля річки.']],
    ['grammar', ['Це моя новий книга.', 'Це моя нова книга.'], ['Це моя старий зошит.', 'Це мій старий зошит.'], ['Це моя перший робота.', 'Це моя перша робота.'], ['Це моя останній спроба.', 'Це моя остання спроба.']],
    ['grammar', ['Ці книга лежать на столі.', 'Ці книги лежать на столі.'], ['Ці вікно були відкриті.', 'Ці вікна були відкриті.'], ['Ці лист лежать на столі.', 'Ці листи лежать на столі.'], ['Ці кішка сплять.', 'Ці кішки сплять.']],
    ['grammar', ['Згідно наказу ми пішли.', 'Згідно з наказом ми пішли.'], ['Згідно плану ми пішли.', 'Згідно з планом ми пішли.'], ['Згідно договору ми пішли.', 'Згідно з договором ми пішли.'], ['Згідно закону ми пішли.', 'Згідно із законом ми пішли.', 'Згідно з законом ми пішли.']],
    ['usage', ['Вона приймала участь у виставі.', 'Вона брала участь у виставі.'], ['Ми прийняли міри для захисту будинку.', 'Ми вжили заходів для захисту будинку.'], ['Він прийняв участь у виставі.', 'Він узяв участь у виставі.', 'Він взяв участь у виставі.'], ['Ми приймали участь у виставі.', 'Ми брали участь у виставі.']],
    ['punctuation', ['Я знаю що він прийде.', 'Я знаю, що він прийде.'], ['Вона сказала що повернеться.', 'Вона сказала, що повернеться.'], ['Я думаю що все вийде.', 'Я думаю, що все вийде.'], ['Він зрозумів що помилився.', 'Він зрозумів, що помилився.']],
    ['punctuation', ['Коли стемніло ми повернулися.', 'Коли стемніло, ми повернулися.'], ['Коли розвиднілося ми повернулися.', 'Коли розвиднілося, ми повернулися.'], ['Коли потепліло ми повернулися.', 'Коли потепліло, ми повернулися.'], ['Коли похолодало ми повернулися.', 'Коли похолодало, ми повернулися.']],
    ['punctuation', ['Це будинок який збудував мій батько.', 'Це будинок, який збудував мій батько.'], ['Це книга яку я прочитав.', 'Це книга, яку я прочитав.'], ['Це повідомлення яке я отримав.', 'Це повідомлення, яке я отримав.'], ['Це люди які нам допомогли.', 'Це люди, які нам допомогли.']],
    ['punctuation', ['Привіт,світе!', 'Привіт, світе!'], ['Так,звичайно.', 'Так, звичайно.'], ['Ні,дякую.', 'Ні, дякую.'], ['Я побачив його,і усміхнувся.', 'Я побачив його, і усміхнувся.']],
    ['punctuation', ['Вона прийшла,, а він пішов.', 'Вона прийшла, а він пішов.'], ['Ми повернулися,, а вони пішли.', 'Ми повернулися, а вони пішли.'], ['Він знав відповідь , але мовчав.', 'Він знав відповідь, але мовчав.'], ['Вона відчинила вікно , але промовчала.', 'Вона відчинила вікно, але промовчала.']],
    ['capitalization', ['ми повернулися додому.', 'Ми повернулися додому.'], ['вона відчинила двері.', 'Вона відчинила двері.'], ['він приїхав у київ.', 'Він приїхав у Київ.'], ['вона приїхала у львів.', 'Вона приїхала у Львів.']],
    ['repetition', ['Вона відкрила відкрила двері.', 'Вона відкрила двері.'], ['Він прочитав прочитав лист.', 'Він прочитав лист.'], ['Ми побачили побачили будинок.', 'Ми побачили будинок.'], ['Вони зачинили зачинили вікно.', 'Вони зачинили вікно.']],
  ],
  en: [
    ['grammar', ['She have a red coat.', 'She has a red coat.'], ['He have a blue pen.', 'He has a blue pen.'], ['She have a new book.', 'She has a new book.'], ['He have an old letter.', 'He has an old letter.']],
    ['grammar', ['He go to school every day.', 'He goes to school every day.'], ['She read books every day.', 'She reads books every day.'], ['He write letters every day.', 'He writes letters every day.'], ['She enjoy reading books.', 'She enjoys reading books.']],
    ['grammar', ['I has a question.', 'I have a question.'], ['We has a question.', 'We have a question.'], ['They has a question.', 'They have a question.'], ['You has a question.', 'You have a question.']],
    ['grammar', ['We was at home.', 'We were at home.'], ['They was outside.', 'They were outside.'], ['You was at school.', 'You were at school.'], ['The children was asleep.', 'The children were asleep.']],
    ['grammar', ['These cat are asleep.', 'These cats are asleep.'], ['These book are new.', 'These books are new.'], ['These window are open.', 'These windows are open.'], ['These letter are old.', 'These letters are old.']],
    ['grammar', ['This is an test.', 'This is a test.'], ['This is an book.', 'This is a book.'], ['This is an window.', 'This is a window.'], ['This is a apple.', 'This is an apple.']],
    ['grammar', ['There is three books here.', 'There are three books here.'], ['There is two letters here.', 'There are two letters here.'], ['There is four cats here.', 'There are four cats here.'], ['There is five windows here.', 'There are five windows here.']],
    ['grammar', ['I am interested on history.', 'I am interested in history.'], ['She is interested on music.', 'She is interested in music.'], ['He is interested on art.', 'He is interested in art.'], ['We are interested on science.', 'We are interested in science.']],
    ['punctuation', ['Hello,world!', 'Hello, world!'], ['Yes,please.', 'Yes, please.'], ['No,thanks.', 'No, thanks.'], ['She arrived,and he left.', 'She arrived, and he left.']],
    ['punctuation', ['However we decided to stay.', 'However, we decided to stay.'], ['Moreover we decided to stay.', 'Moreover, we decided to stay.'], ['Nevertheless we decided to stay.', 'Nevertheless, we decided to stay.'], ['Therefore we decided to stay.', 'Therefore, we decided to stay.']],
    ['punctuation', ['She arrived,, and he left.', 'She arrived, and he left.'], ['We returned,, and they left.', 'We returned, and they left.'], ['He knew the answer , but stayed silent.', 'He knew the answer, but stayed silent.'], ['She opened the window , but stayed silent.', 'She opened the window, but stayed silent.']],
    ['punctuation', ['It happened yesterday..', 'It happened yesterday.'], ['They returned today..', 'They returned today.'], ['She opened the window..', 'She opened the window.'], ['He closed the door..', 'He closed the door.']],
    ['capitalization', ['we went home.', 'We went home.'], ['she opened the door.', 'She opened the door.'], ['He lives in london.', 'He lives in London.'], ['She lives in kyiv.', 'She lives in Kyiv.']],
    ['repetition', ['She opened the the door.', 'She opened the door.'], ['We went went home.', 'We went home.'], ['They saw saw the house.', 'They saw the house.'], ['He read read the letter.', 'He read the letter.']],
  ],
};

const context = {
  ru: ['', 'Вчера. ', 'Сегодня. ', 'Утром. '],
  uk: ['', 'Учора. ', 'Сьогодні. ', 'Уранці. '],
  en: ['', 'Yesterday. ', 'Today. ', 'This morning. '],
};
const cases = [];
for (const lang of ['ru', 'uk', 'en']) {
  const selected = mistakes.filter(item => item.lang === lang).map(item => ({ ...item, origin: 'frozen-v1' }));
  const seen = new Set(selected.map(item => item.text));
  for (const prefix of context[lang]) for (const [category, ...variants] of families[lang]) for (const [wrong, ...correct] of variants) {
    const text = prefix + wrong;
    if (seen.has(text) || selected.length >= 200) continue;
    seen.add(text);
    selected.push({ id: `${lang}-quality-${String(selected.length + 1).padStart(3, '0')}`, lang, category, text, gold: correct.map(value => prefix + value), expected: 'correction', origin: 'language-family' });
  }
  if (selected.length !== 200) throw new Error(`${lang}: expected 200 errors, got ${selected.length}`);
  cases.push(...selected);
}
const controls = cases.map(item => ({ id: `${item.id}-clean`, lang: item.lang, category: item.category, text: item.gold[0], gold: [], expected: 'no-error', origin: item.origin }));
export const LANGUAGE_QUALITY_CASES = cases;
export const LANGUAGE_QUALITY_CONTROLS = controls;
export const LANGUAGE_QUALITY_CONTRACT_VERSION = 1;
