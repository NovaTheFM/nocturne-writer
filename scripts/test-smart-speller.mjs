import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { CLASSICAL_LANGUAGE_RULES } from '../src/core/language-data/classical-rules.js';

const spellingRule = { issueType: 'misspelling', category: { id: 'TYPOS', name: 'Spelling' } };
async function withSpellerResponse(matches, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ matches }) });
  try { await run(); } finally { globalThis.fetch = original; }
}

test('offline dictionary detects known errors without network requests or invented guesses', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network access'); };
  try {
    const matches = await getSmartSpellerMatches(['вообщем', 'сдесь', 'НоcturneUnknownName'], { mode: 'local' });
    assert.equal(matches.get('вообщем')?.correct, 'в общем');
    assert.equal(matches.get('сдесь')?.correct, 'здесь');
    assert.equal(matches.has('ноcturneunknownname'), false);
  } finally { globalThis.fetch = fetchBefore; }
});

test('failed online checks remain retryable and receive contextual sentences', async () => {
  const fetchBefore = globalThis.fetch; let requests = 0, received = '';
  globalThis.fetch = async (_url, options) => {
    received = new URLSearchParams(options.body).get('text');
    if (++requests === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ matches: [{ offset: 5, length: 7, replacements: [{ value: 'word' }], rule: { category: { name: 'Spelling' } } }] }) };
  };
  try {
    const options = { mode: 'api', contextText: 'This mistype sentence needs context.' };
    await assert.rejects(getSmartSpellerMatches(['mistype'], options));
    assert.equal((await getSmartSpellerMatches(['mistype'], options)).get('mistype')?.correct, 'word');
    assert.equal(received, options.contextText); assert.equal(requests, 2);
  } finally { globalThis.fetch = fetchBefore; }
});

test('Smart uses the effective dictionary and does not reuse cached builtin replacements', async () => {
  await getSmartSpellerMatches(['вообщем'], { mode: 'local' });
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup: {} })).has('вообщем'), false);
  const localLookup = { вообщем: { correct: 'в целом', label: 'Авторское правило' } };
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup })).get('вообщем')?.correct, 'в целом');
  localLookup.вообщем.correct = 'в общем-то';
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup })).get('вообщем')?.correct, 'в общем-то');
});

test('disabled rules and protected names remain ignored in every Smart mode', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Ignored words must not trigger a request'); };
  try {
    for (const mode of ['local', 'hybrid', 'api']) {
      const matches = await getSmartSpellerMatches(['Вообщем', 'NocturneName'], { mode, ignoredWords: new Set(['вообщем', 'nocturnename']), contextText: 'Вообщем NocturneName.' });
      assert.equal(matches.size, 0);
    }
  } finally { globalThis.fetch = fetchBefore; }
});

test('online Smart checks requested words beyond the first 4000 characters', async () => {
  const fetchBefore = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    const text = new URLSearchParams(options.body).get('text'); requests.push(text);
    const matches = [...text.matchAll(/tailmistype|frontmistype/gu)].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: 'correct' }] }));
    return { ok: true, json: async () => ({ matches }) };
  };
  try {
    const matches = await getSmartSpellerMatches(['frontmistype', 'tailmistype'], { mode: 'api', contextText: `A frontmistype sentence. ${'ordinary text. '.repeat(600)}A tailmistype sentence.` });
    assert.equal(matches.get('frontmistype')?.correct, 'correct');
    assert.equal(matches.get('tailmistype')?.correct, 'correct');
    assert.ok(requests.every(text => text.length <= 4000));
    assert.ok(requests.some(text => text.includes('A tailmistype sentence.')));
  } finally { globalThis.fetch = fetchBefore; }
});

test('a cancelled Smart response cannot populate the shared result cache', async () => {
  const fetchBefore = globalThis.fetch, controller = new AbortController();
  let release, requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ matches: [{ offset: 0, length: 12, replacements: [{ value: requests === 1 ? 'obsolete' : 'current' }] }] }) };
  };
  try {
    const options = { mode: 'api', contextText: 'abortmistype sentence.' };
    const pending = getSmartSpellerMatches(['abortmistype'], { ...options, signal: controller.signal });
    controller.abort(); release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await getSmartSpellerMatches(['abortmistype'], options)).get('abortmistype')?.correct, 'current');
    assert.equal(requests, 2);
  } finally { globalThis.fetch = fetchBefore; }
});

test('online suggestions retain the case and position of each occurrence', async () => {
  const text = 'The adress is wrong. ADRESS is wrong.';
  await withSpellerResponse([
    { offset: text.indexOf('adress'), length: 6, replacements: [{ value: 'address' }], rule: spellingRule },
    { offset: text.indexOf('ADRESS'), length: 6, replacements: [{ value: 'ADDRESS' }], rule: spellingRule },
  ], async () => {
    const matches = await getSmartSpellerMatches(['adress'], { mode: 'api', contextText: text });
    assert.deepEqual(matches.get('adress')?.occurrences?.map(({ start, correct }) => ({ start, correct })), [{ start: 4, correct: 'address' }, { start: 21, correct: 'ADDRESS' }]);
  });
});

test('Smart rejects invented phrases but retains genuine joined-word corrections', async () => {
  await withSpellerResponse([
    { offset: 0, length: 7, replacements: [{ value: 'Ты серебро' }], rule: spellingRule },
    { offset: 8, length: 4, replacements: [{ value: 'a lot' }], rule: spellingRule },
  ], async () => {
    const matches = await getSmartSpellerMatches(['серебро', 'alot'], { mode: 'api', contextText: 'серебро alot.' });
    assert.equal(matches.has('серебро'), false);
    assert.equal(matches.get('alot')?.correct, 'a lot');
  });
});

test('spelling alternatives are ranked without inventing replacements', async () => {
  await withSpellerResponse([{ offset: 2, length: 6, replacements: [{ value: 'прешёл' }, { value: 'пришёл' }, { value: 'прикол' }], rule: spellingRule }], async () => {
    const matches = await getSmartSpellerMatches(['пришол'], { mode: 'api', contextText: 'Я пришол домой.' });
    assert.equal(matches.get('пришол')?.correct, 'пришёл');
    assert.deepEqual(new Set(matches.get('пришол')?.suggestions), new Set(['прешёл', 'пришёл', 'прикол']));
  });
});

test('splitting a typo into unrelated words does not outrank the actual spelling correction', async () => {
  await withSpellerResponse([
    { offset: 0, length: 6, replacements: [{ value: 'address' }, { value: 'dress' }, { value: 'a dress' }], rule: spellingRule },
    { offset: 7, length: 7, replacements: [{ value: 'тетрадь' }, { value: 'те трать' }, { value: 'тет рать' }], rule: spellingRule },
  ], async () => {
    const result = await getSmartSpellerMatches(['adress', 'тетрать'], { mode: 'api', contextText: 'adress тетрать.' });
    assert.equal(result.get('adress')?.correct, 'address');
    assert.equal(result.get('тетрать')?.correct, 'тетрадь');
  });
});

test('cached online responses serve later word batches without another network request', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ matches: [
    { offset: 0, length: 10, replacements: [{ value: 'first' }], rule: spellingRule },
    { offset: 11, length: 10, replacements: [{ value: 'second' }], rule: spellingRule },
  ] }) }; };
  try {
    const options = { mode: 'api', contextText: 'mistypeone mistypetwo.' };
    assert.equal((await getSmartSpellerMatches(['mistypeone'], options)).get('mistypeone')?.correct, 'first');
    assert.equal((await getSmartSpellerMatches(['mistypetwo'], options)).get('mistypetwo')?.correct, 'second');
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('Smart does not treat unchanged words or style preferences as spelling errors', async () => {
  assert.equal((await getSmartSpellerMatches(['следующее', 'придешь'], { mode: 'local' })).size, 0);
  assert.equal((await getSmartSpellerMatches(['росказни'], { mode: 'local' })).get('росказни')?.correct, 'россказни');
  await withSpellerResponse([{ offset: 0, length: 7, replacements: [{ value: 'золото' }], rule: { issueType: 'style', category: { id: 'STYLE', name: 'Style' } } }], async () => {
    assert.equal((await getSmartSpellerMatches(['серебро'], { mode: 'api', contextText: 'серебро лежало на столе.' })).size, 0);
  });
});

test('repeated typos in distant context windows retain their original positions', async () => {
  const original = globalThis.fetch, requests = [];
  const text = `distantmistype. ${'Обычный текст. '.repeat(650)}DISTANTMISTYPE. ${'Обычный текст. '.repeat(650)}distantmistype.`;
  globalThis.fetch = async (_url, options) => {
    const chunk = new URLSearchParams(options.body).get('text'); requests.push(chunk);
    return { ok: true, json: async () => ({ matches: [...chunk.matchAll(/distantmistype/giu)].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: match[0] === match[0].toUpperCase() ? 'CORRECTION' : 'correction' }], rule: spellingRule })) }) };
  };
  try {
    const result = await getSmartSpellerMatches(['distantmistype'], { mode: 'api', contextText: text });
    assert.deepEqual(result.get('distantmistype')?.occurrences.map(({ start, rawText, correct }) => ({ start, rawText, correct })), [
      { start: 0, rawText: 'distantmistype', correct: 'correction' },
      { start: text.indexOf('DISTANTMISTYPE'), rawText: 'DISTANTMISTYPE', correct: 'CORRECTION' },
      { start: text.lastIndexOf('distantmistype'), rawText: 'distantmistype', correct: 'correction' },
    ]);
    assert.ok(requests.every(chunk => chunk.length <= 4000));
  } finally { globalThis.fetch = original; }
});

test('online requests select declarative rules and reject unrequested or AI rules', async () => {
  const original = globalThis.fetch, ruleId = CLASSICAL_LANGUAGE_RULES.en[0];
  globalThis.fetch = async (_url, options) => {
    const parameters = new URLSearchParams(options.body);
    assert.equal(parameters.get('enabledOnly'), 'true');
    assert.equal(parameters.get('level'), 'picky');
    assert.equal(parameters.get('language'), 'en-US');
    assert.ok(parameters.get('enabledRules').split(',').includes(ruleId));
    return { ok: true, json: async () => ({ matches: [
      { offset: 0, length: 6, replacements: [{ value: 'safe' }], rule: { id: ruleId, issueType: 'grammar' } },
      { offset: 0, length: 6, replacements: [{ value: 'unsafe' }], rule: { id: 'NEURAL_NEW_RULE', issueType: 'grammar' } },
      { offset: 0, length: 6, replacements: [{ value: 'unknown' }], rule: { id: 'NEW_UNREQUESTED_RULE', issueType: 'grammar' } },
    ] }) };
  };
  try {
    const result = await getSmartSpellerMatches(['unique'], { mode: 'api', lang: 'auto', contextText: 'Unique request for declarative checking.' });
    assert.deepEqual(result.issues.map(issue => issue.correct), ['safe']);
  } finally { globalThis.fetch = original; }
});

test('numeric punctuation receives contextual online checking without any word tokens', async () => {
  const ruleId = CLASSICAL_LANGUAGE_RULES.ru[0], text = '№ 7, № 8';
  await withSpellerResponse([{ offset: 0, length: text.length, replacements: [{ value: '№ 7, 8' }], rule: { id: ruleId, issueType: 'uncategorized' } }], async () => {
    const result = await getSmartSpellerMatches([], { mode: 'api', lang: 'ru', contextText: text });
    assert.equal(result.issues[0]?.correct, '№ 7, 8');
  });
});

test('long numeric contexts keep bounded requests and original correction ranges', async () => {
  const original = globalThis.fetch, chunks = [];
  const suffix = '№ 17, № 18', text = '1 2 3 '.repeat(1200) + suffix;
  globalThis.fetch = async (_url, options) => {
    const chunk = new URLSearchParams(options.body).get('text'); chunks.push(chunk);
    const start = chunk.indexOf(suffix);
    return { ok: true, json: async () => ({ matches: start < 0 ? [] : [{ offset: start, length: suffix.length, replacements: [{ value: '№ 17, 18' }], rule: { id: CLASSICAL_LANGUAGE_RULES.ru[0], issueType: 'uncategorized' } }] }) };
  };
  try {
    const result = await getSmartSpellerMatches([], { mode: 'api', lang: 'ru', contextText: text });
    assert.ok(chunks.length > 1 && chunks.every(chunk => chunk.length <= 4000));
    assert.equal(result.issues[0]?.start, text.indexOf(suffix));
    assert.equal(result.issues[0]?.end, text.length);
    assert.equal(result.issues[0]?.correct, '№ 17, 18');
  } finally { globalThis.fetch = original; }
});

test('cancelling one consumer does not abort a shared check needed by another', async () => {
  const original = globalThis.fetch, controller = new AbortController(); let release, requests = 0, transportSignal;
  globalThis.fetch = async (_url, options) => {
    requests++; transportSignal = options.signal;
    await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ matches: [{ offset: 0, length: 13, replacements: [{ value: 'correction' }] }] }) };
  };
  try {
    const options = { mode: 'api', contextText: 'coalescedword context.' };
    const first = getSmartSpellerMatches(['coalescedword'], { ...options, signal: controller.signal });
    const second = getSmartSpellerMatches(['coalescedword'], options);
    controller.abort(); assert.equal(transportSignal.aborted, false); release();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal((await second).get('coalescedword')?.correct, 'correction'); assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('author replacement wins over a grammatical rule covering the same phrase', async () => {
  const result = await getSmartSpellerMatches(['самий', 'кращий', 'варіант'], { mode: 'local', lang: 'uk', contextText: 'Самий кращий варіант.', localLookup: { самий: { correct: 'Авторский', source: 'user' } } });
  assert.deepEqual(result.issues.map(issue => ({ raw: issue.rawText, correct: issue.correct })), [{ raw: 'Самий', correct: 'Авторский' }]);
});

test('a contextual online correction is retained when a shorter local rule overlaps it', async () => {
  const text = 'Она купил хлеб.';
  await withSpellerResponse([{ offset: 4, length: 10, replacements: [{ value: 'купила хлеб' }], rule: { id: CLASSICAL_LANGUAGE_RULES.ru[0], issueType: 'grammar' } }], async () => {
    const result = await getSmartSpellerMatches(['она', 'купил', 'хлеб'], { mode: 'hybrid', lang: 'ru', contextText: text });
    assert.equal(result.issues.find(issue => issue.rawText === 'купил хлеб')?.correct, 'купила хлеб');
    assert.equal(result.issues.filter(issue => issue.rawText === 'купил').length, 0);
  });
});

test('overlapping online phrases retain local deletions and every remote alternative', async () => {
  const text = 'Она открыла открыла дверь.';
  await withSpellerResponse([{ offset: 4, length: 15, replacements: [{ value: 'открыла, открыла' }, { value: 'открыла и открыла' }], rule: { id: CLASSICAL_LANGUAGE_RULES.ru[0], issueType: 'uncategorized' } }], async () => {
    const result = await getSmartSpellerMatches(['она', 'открыла', 'дверь'], { mode: 'hybrid', lang: 'ru', contextText: text });
    const issue = result.issues.find(issue => issue.rawText === 'открыла открыла');
    assert.equal(issue?.correct, 'открыла');
    assert.deepEqual(issue?.suggestions, ['открыла', 'открыла, открыла', 'открыла и открыла']);
  });
});

test('capitalization cannot hide a broader grammatical diagnostic without a replacement', async () => {
  const text = 'он написал письмо.';
  await withSpellerResponse([{ offset: 0, length: 10, replacements: [], message: 'Check the grammatical construction.', rule: { id: CLASSICAL_LANGUAGE_RULES.ru[0], issueType: 'grammar' } }], async () => {
    const result = await getSmartSpellerMatches(['он', 'написал', 'письмо'], { mode: 'hybrid', lang: 'ru', contextText: text });
    assert.ok(result.issues.some(issue => issue.start === 0 && issue.end === 10 && issue.message === 'Check the grammatical construction.'));
    assert.ok(result.issues.some(issue => issue.correct === 'Он'));
  });
});

test('optional consistent ё is a preference while contextual е/ё grammar stays enabled', async () => {
  const text = 'Все уже готово.', contextual = CLASSICAL_LANGUAGE_RULES.ru.find(id => id !== 'MissingYO');
  await withSpellerResponse([
    { offset: 0, length: 3, replacements: [], message: 'Optional consistent ё.', rule: { id: 'MissingYO', issueType: 'uncategorized' } },
    { offset: 0, length: 3, replacements: [{ value: 'Всё' }], rule: { id: contextual, issueType: 'grammar' } },
  ], async () => {
    const result = await getSmartSpellerMatches(['все', 'уже', 'готово'], { mode: 'api', lang: 'ru', contextText: text });
    assert.deepEqual(result.issues.map(issue => issue.correct), ['Всё']);
  });
});

test('short transpositions use dictionary words while informal repetition is preserved', async () => {
  const result = await getSmartSpellerMatches(['teh', 'adn', 'lol'], { mode: 'local', lang: 'en', contextText: 'I have teh book. Bread adn milk. He typed lol.' });
  assert.equal(result.get('teh')?.correct, 'the'); assert.equal(result.get('adn')?.correct, 'and'); assert.equal(result.has('lol'), false);
});

test('API-only mode exposes author replacements through the canonical occurrence contract', async () => {
  const result = await getSmartSpellerMatches(['authoralias'], { mode: 'api', contextText: 'Authoralias.', localLookup: { authoralias: { correct: 'Literal choice', source: 'user' } } });
  assert.deepEqual(result.issues.map(issue => ({ start: issue.start, raw: issue.rawText, correct: issue.correct })), [{ start: 0, raw: 'Authoralias', correct: 'Literal choice' }]);
});

test('worker startup failure retains local rules without claiming a complete check', async () => {
  const previousWindow = globalThis.window, previousWorker = globalThis.Worker;
  globalThis.window = {}; globalThis.Worker = class { constructor() { throw new Error('Dictionary asset unavailable'); } };
  try {
    const result = await getSmartSpellerMatches(['вообщем', 'uncheckabletoken'], { mode: 'local', lang: 'ru', contextText: 'Вообщем uncheckabletoken.' });
    assert.ok(result.degraded);
    assert.equal(result.checkedWords.has('uncheckabletoken'), false);
    assert.ok(result.issues.some(issue => issue.rawText === 'Вообщем' && issue.correct === 'В общем'));
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker;
  }
});

test('apostrophe mistakes use real forms and correct English contractions remain unchanged', async () => {
  for (const [text, gold] of [
    ['Це новий підїзд.', "Це новий під'їзд."], ['Це новий компютер.', "Це новий комп'ютер."],
    ['Це новий обєкт.', "Це новий об'єкт."], ["Слово: п’ятницця.", 'Слово: п’ятниця.'],
  ]) {
    const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’']\p{L}+)*/gu), { mode: 'local', lang: 'uk', contextText: text });
    assert.ok(result.issues.some(issue => issue.suggestions.some(value => text.slice(0, issue.start) + value + text.slice(issue.end) === gold)), text);
  }
  for (const text of ["I don't know.", 'I don’t know.', "She can't swim.", "We won't go.", "They're here.", "John's book is here."]) {
    const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’']\p{L}+)*/gu), { mode: 'local', lang: 'en', contextText: text });
    assert.equal(result.issues.length, 0, JSON.stringify({ text, issues: result.issues }));
  }
});
