import assert from 'node:assert/strict';
import test from 'node:test';
import { characterNameReplacement } from '../src/features/character-rename.js';
import { collectManuscriptMatches } from '../src/features/manuscript-search.js';
import { rankLoreItemsByRelevance } from '../src/features/ai-context.js';

const character = (firstName, lastName = '', extra = {}) => ({ id: 'hero', firstName, lastName, name: [firstName, lastName].filter(Boolean).join(' '), displayName: [firstName, lastName].filter(Boolean).join(' '), ...extra });
const rename = (from, to, text) => characterNameReplacement(typeof from === 'string' ? character(from) : from, typeof to === 'string' ? character(to) : to).text(text);

test('all six cases are replaced without manually entered forms', () => {
  assert.equal(rename('Зейн', 'Оррин', 'Зейн; у Зейна; к Зейну; вижу Зейна; с Зейном; о Зейне.'), 'Оррин; у Оррина; к Оррину; вижу Оррина; с Оррином; о Оррине.');
});
test('context distinguishes genitive/accusative and dative/prepositional across declensions', () => {
  assert.equal(rename('Зейн', 'Анна', 'У Зейна ключ. Вижу Зейна. К Зейну. С Зейном. О Зейне.'), 'У Анны ключ. Вижу Анну. К Анне. С Анной. О Анне.');
  assert.equal(rename('Анна', 'Зейн', 'У Анны. Вижу Анну. К Анне. О Анне. С Анной. Анна пришла.'), 'У Зейна. Вижу Зейна. К Зейну. О Зейне. С Зейном. Зейн пришла.');
});
test('invented indeclinable vowel names stay whole and carry context into a declinable replacement', () => {
  for (const name of ['Аеири', 'Эйо', 'Кьёу', 'Юэ', 'Ли', 'Эллю', 'Аеыры', 'Кайе']) {
    assert.equal(rename('Зейн', name, 'Зейн; у Зейна; к Зейну; вижу Зейна; с Зейном; о Зейне.'), Array(6).fill(name).map((n, i) => ['', 'у ', 'к ', 'вижу ', 'с ', 'о '][i] + n).join('; ') + '.');
    assert.equal(rename(name, 'Зейн', `${name}; у ${name}; к ${name}; вижу ${name}; с ${name}; о ${name}.`), 'Зейн; у Зейна; к Зейну; вижу Зейна; с Зейном; о Зейне.');
  }
});
test('soft endings, spelling rules and alternate instrumental endings', () => {
  const examples = [
    ['Мария', 'Лия', 'Марии; к Марии; о Марии; с Марией; с Мариею', 'Лии; к Лии; о Лии; с Лией; с Лиею'],
    ['Никита', 'Илья', 'Никиты; Никите; Никиту; Никитой', 'Ильи; Илье; Илью; Ильёй'],
    ['Игорь', 'Юрий', 'Игоря; Игорю; Игорем; об Игоре', 'Юрия; Юрию; Юрием; об Юрии'],
    ['Маша', 'Фейя', 'Маши; Маше; Машу; Машей', 'Фейи; Фейе; Фейю; Фейей'],
    ['Зейн', 'Аэрика', 'Зейна; Зейну; Зейном; Зейне', 'Аэрики; Аэрике; Аэрикой; Аэрике'],
  ];
  for (const [from, to, text, expected] of examples) assert.equal(rename(from, to, text), expected, `${from} → ${to}`);
});
test('irregular stems and feminine consonants', () => {
  for (const [name, forms] of [
    ['Павел', ['Павла', 'Павлу', 'Павлом', 'Павле']],
    ['Пётр', ['Петра', 'Петру', 'Петром', 'Петре']],
    ['Лев', ['Льва', 'Льву', 'Львом', 'Льве']],
    ['Любовь', ['Любови', 'Любови', 'Любовью', 'Любови']],
  ]) assert.equal(rename(name, 'Аеири', `${name}, ${forms.join(', ')}`), Array(5).fill('Аеири').join(', '));
  assert.equal(rename(character('Элис', 'Блэк'), character('Мария', 'Северная'), 'У Элис Блэк; с Элис Блэк.'), 'У Марии Северной; с Марией Северной.');
});
test('full names and separate surnames use the same case with gender agreement', () => {
  assert.equal(rename(character('Зейн', 'Леранте'), character('Мария', 'Северная'), 'Зейн Леранте; у Зейна Леранте; к Зейну Леранте; вижу Зейна Леранте; с Зейном Леранте; о Зейне Леранте.'), 'Мария Северная; у Марии Северной; к Марии Северной; вижу Марию Северную; с Марией Северной; о Марии Северной.');
  assert.equal(rename(character('Иван', 'Петров'), character('Олег', 'Толстой'), 'Петрова; к Петрову; с Петровым; о Петрове.'), 'Толстого; к Толстому; с Толстым; о Толстом.');
});
test('hyphens, particles and apostrophes survive compound-name inflections', () => {
  assert.equal(rename('Анна-Мария', 'Жан-Поль', 'У Анны-Марии; к Анне-Марии; с Анной-Марией; о Анне-Марии.'), 'У Жана-Поля; к Жану-Полю; с Жаном-Полем; о Жане-Поле.');
  assert.equal(rename(character('Зейн', 'де Леранте'), character('Игорь', 'фон Блэк'), 'С Зейном де Леранте; о Зейне де Леранте.'), 'С Игорем фон Блэком; о Игоре фон Блэке.');
  assert.equal(rename("Кай'Зейн", "Аль’Оррин", "к Кай'Зейну"), 'к Аль’Оррину');
});
test('case, ё/е, accents and Unicode boundaries do not damage other words', () => {
  assert.equal(rename('Пётр', 'Оррин', 'ПЕТРА; петру; Петра; СверхПетра; Петра2; Пётр; Петр'), 'ОРРИНА; оррину; Оррина; СверхПетра; Петра2; Оррин; Оррин');
  assert.equal(rename('Зейн', 'Оррин', 'Зейна; Зейнада; Зейнор; Кай-Зейна; Зейна\u0301да; Зейн2'), 'Оррина; Зейнада; Зейнор; Кай-Зейна; Зейна\u0301да; Зейн2');
  assert.equal(rename('Зейн', 'Оррин', 'с Зе́йном; к Зе́йну'), 'с Оррином; к Оррину');
});
test('replacement never expands new full-name forms on a second pass', () => {
  const r = characterNameReplacement(character('Анна'), character('Анна', 'Мария'));
  const text = 'Анна; у Анны; с Анной; у Анны Марии; с Анной Марией';
  const next = r.text(text);
  assert.equal(next, 'Анна Мария; у Анны Марии; с Анной Марией; у Анны Марии; с Анной Марией');
  assert.equal(r.text(next), next);
});
test('explicit paired custom forms override automatic forms', () => {
  assert.equal(rename(character('Зейн', '', { mentionForms: ['Зейнушка', 'Зейном'] }), character('Оррин', '', { mentionForms: ['Орри', 'Оррином-воином'] }), 'Зейнушка; с Зейном; к Зейну'), 'Орри; с Оррином-воином; к Оррину');
});
test('manuscript alias search and AI context recognize automatic forms', () => {
  const entity = character('Павел', 'Северный', { aliases: ['Лев'] });
  const doc = { id: 'doc', docType: 'book-chapter', workTitle: 'К Павлу Северному. С Павлом Северным. О Льве.', ast: { blocks: [] } };
  assert.equal(collectManuscriptMatches(doc, 'Павел Северный', { aliases: true, wholeWords: true }, [entity]).length, 3);
  assert.deepEqual(rankLoreItemsByRelevance([entity, character('Мария')], 'Разговор с Павлом Северным'), [entity]);
});
