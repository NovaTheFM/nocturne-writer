export const NAME_CASES = ['nominative', 'genitive', 'dative', 'accusative', 'instrumental', 'prepositional'];

const particles = new Set(['де', 'дель', 'ди', 'да', 'дос', 'дез', 'ду', 'фон', 'ван', 'дер', 'ден', 'ла', 'ле', 'аль', 'эль', 'ибн', 'бин']);
const maleNames = new Set(['илья', 'никита', 'кузьма', 'фома', 'лука', 'савва', 'данила', 'данило', 'шота', 'юноша', 'миша', 'паша', 'лёва', 'лев', 'павел', 'пётр', 'петр']);
const feminineSoft = new Set(['любовь', 'агарь', 'рахиль', 'руфь', 'суламифь', 'эсфирь', 'юдифь', 'рашель']);
const femaleNames = new Set([...feminineSoft, 'элис', 'нинель', 'гузель', 'адель', 'николь', 'мишель', 'рут', 'кармен', 'мэри', 'мери', 'анн', 'инес', 'ирен']);
const invariant = new Set(['дюма', 'золя', 'дега', 'тома', 'люка', 'делакруа', 'гарсиа', 'гарсия', 'гурцкая']);
const irregular = { павел: ['Павла', 'Павлу', 'Павла', 'Павлом', 'Павле'], пётр: ['Петра', 'Петру', 'Петра', 'Петром', 'Петре'], лев: ['Льва', 'Льву', 'Льва', 'Львом', 'Льве'] };
const paradigmCache = new Map();
const mentionsCache = new WeakMap();
export const normalizeName = value => String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[\u0300-\u036f]/g, '').replace(/[’]/g, "'").replace(/[‐‑]/g, '-').replace(/\s+/g, ' ').trim();

export function inferCharacterGender(character = {}, fallback = 'masculine') {
  const explicit = String(character.gender || character.sex || '').toLocaleLowerCase('ru');
  if (['female', 'feminine', 'woman', 'женский', 'женщина', 'ж'].includes(explicit)) return 'feminine';
  if (['male', 'masculine', 'man', 'мужской', 'мужчина', 'м'].includes(explicit)) return 'masculine';
  const first = String(character.firstName || character.displayName || character.name || '').toLocaleLowerCase('ru').split(/[\s-]/u)[0];
  if (maleNames.has(first)) return 'masculine';
  if (femaleNames.has(first)) return 'feminine';
  const surname = String(character.lastName || '').toLocaleLowerCase('ru');
  if (/(?:ова|ева|ёва|ина|ына|ая|яя)$/u.test(surname)) return 'feminine';
  if (/(?:ов|ев|ёв|ин|ын|ый|ой|ский|цкий)$/u.test(surname)) return 'masculine';
  if (/[ая]$/u.test(first)) return 'feminine';
  if (/[бвгджзклмнпрстфхцчшщйь]$/u.test(first)) return 'masculine';
  return fallback;
}

function caseStyle(value, template) {
  if (template === template.toLocaleUpperCase('ru')) return value.toLocaleUpperCase('ru');
  if (template === template.toLocaleLowerCase('ru')) return value.toLocaleLowerCase('ru');
  return value;
}

function wordParadigm(word, gender, kind) {
  const plain = word.replace(/[\u0300-\u036f]/g, ''), lower = plain.toLocaleLowerCase('ru');
  const same = () => NAME_CASES.map(() => [plain]);
  if (!/^[а-яё]+$/iu.test(plain) || particles.has(lower) || invariant.has(lower)) return same();
  if (kind !== 'lastName' && irregular[lower.replace(/е(?=тр$)/u, 'ё')]) {
    return [[plain], ...irregular[lower.replace(/е(?=тр$)/u, 'ё')].map(form => [caseStyle(form, plain)])];
  }
  const end = lower.at(-1), stem = plain.slice(0, -1);
  const forms = endings => endings.map(ending => (Array.isArray(ending) ? ending : [ending]).map(suffix => stem + suffix));
  if (kind === 'lastName' && /(?:ых|их)$/u.test(lower)) return same();
  if (kind === 'lastName' && /(?:ая|яя)$/u.test(lower)) {
    const base = plain.slice(0, -2), soft = lower.endsWith('яя');
    return [plain, ...[soft ? 'ей' : 'ой', soft ? 'ей' : 'ой', soft ? 'юю' : 'ую', soft ? 'ей' : 'ой', soft ? 'ей' : 'ой'].map(suffix => base + suffix)].map(form => [form]);
  }
  if (kind === 'lastName' && /(?:ый|ой|ский|цкий|ний|гий|хий|жий|чий|ший)$/u.test(lower)) {
    if (gender === 'feminine') return same();
    const base = plain.slice(0, -2), soft = lower.endsWith('ий') && !/[кгх]ий$/u.test(lower);
    return [plain, base + (soft ? 'его' : 'ого'), base + (soft ? 'ему' : 'ому'), base + (soft ? 'его' : 'ого'), base + (/[кгх]ий$/u.test(lower) || soft ? 'им' : 'ым'), base + (soft ? 'ем' : 'ом')].map(form => [form]);
  }
  if (kind === 'lastName' && /(?:ова|ева|ёва|ина|ына)$/u.test(lower)) return forms(['а', 'ой', 'ой', 'у', ['ой', 'ою'], 'ой']);
  if (end === 'а') {
    if (/[аеёиоуыэю]а$/u.test(lower)) return same();
    const genitive = /[гкхжчшщ]а$/u.test(lower) ? 'и' : 'ы';
    const instrumental = /[жчшщц]а$/u.test(lower) ? 'ей' : 'ой';
    return forms(['а', genitive, 'е', 'у', [instrumental, instrumental.slice(0, -1) + 'ю'], 'е']);
  }
  if (end === 'я') {
    if (lower.endsWith('ия')) return forms(['я', 'и', 'и', 'ю', ['ей', 'ею'], 'и']);
    const ins = lower === 'илья' ? 'ёй' : 'ей';
    return forms(['я', 'и', 'е', 'ю', [ins, ins.slice(0, -1) + 'ю'], 'е']);
  }
  if (end === 'ь' && feminineSoft.has(lower) && kind !== 'lastName') return forms(['ь', 'и', 'и', 'ь', 'ью', 'и']);
  if (gender === 'feminine' || /[еёиоуыэю]$/u.test(lower)) return same();
  if (end === 'ь' || end === 'й') return forms([end, 'я', 'ю', 'я', 'ем', lower.endsWith('ий') ? 'и' : 'е']);
  const ins = kind === 'lastName' && /(?:ов|ев|ёв|ин|ын)$/u.test(lower) && !['дарвин', 'чаплин', 'франклин'].includes(lower) ? 'ым' : /[жчшщц]$/u.test(lower) ? 'ем' : 'ом';
  return [plain, plain + 'а', plain + 'у', plain + 'а', plain + ins, plain + 'е'].map(form => [form]);
}

export function nameParadigm(name = '', { gender = 'masculine', kind = 'firstName', lastName = '' } = {}) {
  const value = String(name).trim(), key = JSON.stringify([value, gender, kind, lastName]);
  if (paradigmCache.has(key)) return paradigmCache.get(key);
  const parts = value.split(/([\s‐‑-]+)/u);
  const apostrophe = part => {
    const split = part.match(/^(.*['’])([^'’]+)$/u);
    return split ? wordParadigm(split[2], gender, kind).map(forms => forms.map(form => split[1] + form)) : wordParadigm(part, gender, kind);
  };
  const surnameStart = lastName && value.endsWith(lastName) ? value.length - lastName.length : Infinity;
  let offset = 0;
  const paradigms = parts.map(part => {
    const position = offset; offset += part.length;
    if (/^[\s‐‑-]+$/u.test(part)) return NAME_CASES.map(() => [part]);
    return position >= surnameStart ? wordParadigm(part, gender, 'lastName') : apostrophe(part);
  });
  const result = Object.fromEntries(NAME_CASES.map((nameCase, index) => {
    let forms = [''];
    for (const part of paradigms) forms = forms.flatMap(prefix => part[index].map(form => prefix + form)).slice(0, 64);
    return [nameCase, Object.freeze([...new Set(forms)])];
  }));
  if (paradigmCache.size >= 512) paradigmCache.delete(paradigmCache.keys().next().value);
  paradigmCache.set(key, Object.freeze(result));
  return result;
}

export function characterMentionForms(character = {}, { includeSurname = true } = {}) {
  const signature = JSON.stringify([character.displayName, character.name, character.firstName, character.lastName, character.aliases, character.mentionForms, character.gender, character.sex, includeSurname]);
  const cached = mentionsCache.get(character);
  if (cached?.signature === signature) return cached.forms.slice();
  const gender = inferCharacterGender(character), names = [character.displayName, character.name, character.firstName].filter(Boolean);
  const forms = names.flatMap(name => Object.values(nameParadigm(name, { gender, lastName: character.lastName })).flat());
  for (const alias of character.aliases || []) {
    const words = String(alias).trim().split(/\s+/u);
    const lastName = words.length > 1 ? words.at(-1) : '';
    forms.push(...Object.values(nameParadigm(alias, { gender: inferCharacterGender({ name: alias, lastName }, gender), lastName })).flat());
  }
  if (includeSurname && character.lastName) forms.push(...Object.values(nameParadigm(character.lastName, { gender, kind: 'lastName' })).flat());
  forms.push(...(character.mentionForms || []));
  const result = [...new Set(forms.map(form => String(form).trim()).filter(Boolean))];
  mentionsCache.set(character, { signature, forms: result });
  return result.slice();
}

const genitivePrepositions = new Set(['у', 'от', 'до', 'из', 'без', 'для', 'ради', 'около', 'возле', 'после', 'вместо', 'кроме', 'мимо', 'против', 'вокруг', 'вдоль', 'насчет', 'из-за', 'из-под']);
const dativePrepositions = new Set(['к', 'ко', 'по', 'благодаря', 'вопреки', 'навстречу', 'согласно']);
const instrumentalPrepositions = new Set(['с', 'со', 'над', 'надо', 'перед', 'передо', 'между', 'рядом']);
const prepositionalPrepositions = new Set(['о', 'об', 'обо', 'при']);

export function resolveNameCase(candidates, text, start, end) {
  if (candidates.length === 1) return candidates[0];
  const left = normalizeName(text.slice(Math.max(0, start - 120), start).split(/[.!?;,:\n]/u).at(-1));
  const words = left.match(/[а-я]+(?:-[а-я]+)*/gu) || [], near = words.slice(-4);
  const choose = (...cases) => cases.find(nameCase => candidates.includes(nameCase));
  const last = words.at(-1) || '';
  const immediatePreposition = genitivePrepositions.has(last) || dativePrepositions.has(last) || instrumentalPrepositions.has(last) || prepositionalPrepositions.has(last) || ['в', 'во', 'на', 'за', 'под', 'подо', 'через', 'про', 'сквозь'].includes(last);
  const genitiveHead = /(?:^|\s)(?:нет|отсутствие|отсутствия|имя|имени|смерть|смерти|голос|голоса|след|следы|жизнь|жизни|письмо|письма|взгляд|взгляда|дом|дома|рука|руки|слова|брат|сестра|друг|друга|не было|не стало)\s*$/u.test(left);
  const right = normalizeName(text.slice(end, end + 70));
  if (candidates.includes('nominative') && !immediatePreposition && !genitiveHead && !/(?:ого|его|ому|ему|ой|ей|ым|им|ую|юю)$/u.test(last) && /^(?:был[аи]?|будет|есть|стал[аи]?|сид\p{L}*|стоя\p{L}*|приш\p{L}*|пош\p{L}*|вош\p{L}*|выш\p{L}*|сказ\p{L}*|говор\p{L}*|смотр\p{L}*|улыб\p{L}*|засме\p{L}*|остал\p{L}*|появил\p{L}*)(?![\p{L}\p{M}])/u.test(right)) return 'nominative';
  let preferred;
  for (let index = near.length - 1; index >= 0 && !preferred; index--) {
    const word = near[index];
    if (genitivePrepositions.has(word)) preferred = choose('genitive');
    else if (dativePrepositions.has(word)) preferred = choose('dative');
    else if (prepositionalPrepositions.has(word)) preferred = choose('prepositional');
    else if (instrumentalPrepositions.has(word)) preferred = choose('instrumental', 'genitive');
    else if (['в', 'во', 'на'].includes(word)) preferred = /(?:ид[еу]|пош[её]л|пойду|пришел|смотр|гляд|взгля|направ|полет|брос|прыг)/u.test(left) ? choose('accusative', 'prepositional') : choose('prepositional', 'accusative');
    else if (['за', 'под', 'подо'].includes(word)) preferred = choose('instrumental', 'accusative');
    else if (['через', 'про', 'сквозь'].includes(word)) preferred = choose('accusative');
  }
  if (preferred) return preferred;
  if (genitiveHead) return choose('genitive') || candidates[0];
  if (/(?:^|\s)(?:вижу|видел[аи]?|увидел[аи]?|увижу|встреч\p{L}*|встрет\p{L}*|люб\p{L}*|зов[уе]\p{L}*|позвал[аи]?|наш[её]л[аи]?|найду|жду|ждал[аи]?|обнял[аи]?|обним\p{L}*|ищ\p{L}*|искал[аи]?|помню|знаю|убил[аи]?|спас[ау]?|ненавижу)\s*$/u.test(left)) return choose('accusative') || candidates[0];
  if (/(?:^|\s)(?:помог\p{L}*|помо\p{L}*|верю|довер\p{L}*|сказал[аи]?|скажу|ответил[аи]?|отвеч\p{L}*|пишу|написал[аи]?|дал[аи]?|дам|подарил[аи]?)\s*$/u.test(left)) return choose('dative') || candidates[0];
  if (/(?:^|\s)(?:горжусь|гордил\p{L}*|восхища\p{L}*|любуюсь|доволен|довольна)\s*$/u.test(left)) return choose('instrumental') || candidates[0];
  // Identical forms cannot encode a case by themselves; keep the source paradigm's order.
  return choose('nominative', 'genitive', 'dative', 'accusative', 'instrumental', 'prepositional');
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literalPattern = name => [...name.replace(/[\u0300-\u036f]/g, '')].map(char => /\s/u.test(char) ? '\\s+' : /[её]/iu.test(char) ? '[её][\\u0300-\\u036f]*' : /[-‐‑]/u.test(char) ? '[-‐‑]' : /['’]/u.test(char) ? "['’]" : escapePattern(char) + (/\p{L}/u.test(char) ? '[\\u0300-\\u036f]*' : '')).join('');

export function createCharacterNameReplacement(before, after, { characters = [] } = {}) {
  const entries = new Map(), oldGender = inferCharacterGender(before), newGender = inferCharacterGender(after, oldGender);
  const add = (from, to, nameCase, variant = 0, explicit = false, preserve = false) => {
    const key = normalizeName(from);
    if (!key) return;
    let entry = entries.get(key);
    if (!entry || explicit) { entry = { from, choices: [] }; entries.set(key, entry); }
    if (!entry.choices.some(choice => choice.nameCase === nameCase && choice.variant === variant)) entry.choices.push({ nameCase, variant, to, preserve });
  };
  for (const field of ['displayName', 'name', 'firstName', 'lastName']) {
    const oldName = String(before[field] || '').trim(), newName = String(after[field] || (field === 'lastName' ? after.firstName : '') || '').trim();
    if (!oldName || oldName === newName) continue;
    const oldForms = nameParadigm(oldName, { gender: oldGender, kind: field, lastName: before.lastName });
    const newForms = nameParadigm(newName, { gender: newGender, kind: field === 'lastName' && !after.lastName ? 'firstName' : field, lastName: after.lastName });
    for (const nameCase of NAME_CASES) oldForms[nameCase].forEach((from, variant) => add(from, newForms[nameCase][Math.min(variant, newForms[nameCase].length - 1)], nameCase, variant));
  }
  if (before.mentionForms?.length === after.mentionForms?.length) before.mentionForms?.forEach((from, index) => {
    const to = after.mentionForms[index];
    if (from && to && from !== to) add(from, to, 'nominative', 0, true);
  });
  // Protect every form of an expanded new name, including forms sharing old components.
  for (const name of [after.displayName, after.name].filter(Boolean)) for (const forms of Object.values(nameParadigm(name, { gender: newGender, lastName: after.lastName }))) for (const form of forms) {
    if (!entries.has(normalizeName(form))) add(form, form, 'nominative', 0, true);
  }
  const oldNames = new Set([before.displayName, before.name, before.firstName, before.lastName].filter(Boolean).map(normalizeName));
  for (const character of characters.filter(character => character.id !== before.id)) {
    const gender = inferCharacterGender(character);
    for (const field of ['displayName', 'name', 'firstName', 'lastName']) {
      const name = character[field];
      if (!name || oldNames.has(normalizeName(name))) continue;
      for (const [nameCase, forms] of Object.entries(nameParadigm(name, { gender, kind: field, lastName: character.lastName }))) forms.forEach((form, variant) => add(form, form, nameCase, variant, false, true));
    }
  }
  const terms = [...entries.values()].sort((a, b) => b.from.length - a.from.length);
  const boundary = "[\\p{L}\\p{M}\\p{N}_'’\\-‐‑]";
  const pattern = terms.length ? new RegExp(`(?<!${boundary})(?:${terms.map(term => literalPattern(term.from)).join('|')})(?!${boundary})`, 'giu') : null;
  const matches = value => {
    const text = String(value);
    if (!pattern) return [];
    return [...text.matchAll(pattern)].flatMap(match => {
      const entry = entries.get(normalizeName(match[0]));
      const nameCase = resolveNameCase([...new Set(entry.choices.map(choice => choice.nameCase))], text, match.index, match.index + match[0].length);
      const choice = entry.choices.find(choice => choice.nameCase === nameCase);
      if (choice.preserve) return [];
      const replacement = caseStyle(choice.to, match[0].replace(/[\u0300-\u036f]/g, ''));
      return replacement === match[0] ? [] : [{ from: match.index, to: match.index + match[0].length, text: replacement }];
    });
  };
  return { matches, text(value) {
    let result = String(value);
    for (const match of matches(result).reverse()) result = result.slice(0, match.from) + match.text + result.slice(match.to);
    return result;
  } };
}
