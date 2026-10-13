const personalSubjects = new Set(['я', 'ты', 'он', 'она', 'оно', 'мы', 'вы', 'они']);
const clauseConjunctions = new Set(['чтобы', 'хотя', 'поскольку', 'когда', 'если', 'пока']);
const interrogativeAdverbs = new Set(['почему', 'зачем']);
const commaMessage = 'В этой конструкции нужна запятая.';

export function russianContextPunctuation(text, tokens, data) {
  const issues = [], commaPositions = new Set(), phraseTokens = new Set(), authorStarts = new Set(), authorRanges = [];
  const gap = (left, right) => left && right && /^[\t \u00a0]+$/u.test(text.slice(left.end, right.start));
  const finite = token => token?.analyses.some(item => item.pos === 'verb' && !['infinitive', 'imperative'].includes(item.tense));
  const imperative = token => token?.analyses.some(item => item.pos === 'verb' && item.tense === 'imperative')
    && !finite(token) && !token.analyses.some(item => item.pos === 'adjective' && item.case === 'Nom');
  const noun = token => token?.analyses.filter(item => item.pos === 'noun' && !item.tag.includes('&pron')) || [];
  const adjective = token => token?.analyses.filter(item => item.pos === 'adjective' && item.case && !/:(?:MPR|PRO)(?::|$)/u.test(item.tag)) || [];
  const addressModifier = token => token?.analyses.some(item => item.pos === 'adjective' && item.case === 'Nom');
  const nominative = token => noun(token).some(item => item.case === 'Nom');
  const predicate = token => finite(token) || token?.analyses.some(item => /^(?:PRDC$|ADJ:Short:|PT_Short:)/u.test(item.tag));
  const clausePredicate = sequence => sequence.some(predicate) || sequence.some((token, index) => (nominative(token) || personalSubjects.has(token.word))
    && adjective(sequence[index + 1]).some(item => item.case === 'Nom') && gap(token, sequence[index + 1]));
  const add = (start, end, replacement, ruleId, category = 'punctuation', message = commaMessage) => {
    if (text.slice(start, end) !== replacement) issues.push({ start, end, suggestions: [replacement], category, ruleId, message });
  };
  const comma = (position, ruleId) => {
    if (text[position] === ',' || commaPositions.has(position)) return;
    commaPositions.add(position); add(position, position, ',', ruleId);
  };
  const markBetween = (left, right, ruleId) => { if (gap(left, right)) comma(left.end, ruleId); };

  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index], next = tokens[index + 1];
    if (token.word !== 'по' || !gap(token, next)) continue;
    const compound = `по-${next.word}`;
    if (!data.analyses.get(compound)?.some(item => item.tag === 'ADV')) continue;
    let following = index + 2;
    if (gap(next, tokens[following]) && noun(tokens[following]).some(item => item.case === 'D')) continue;
    while (following < tokens.length && following < index + 6 && gap(tokens[following - 1], tokens[following])
      && tokens[following].analyses.some(item => item.pos === 'adjective' && item.case === 'D')) following++;
    if (gap(tokens[following - 1], tokens[following]) && noun(tokens[following]).some(item => item.case === 'D')) continue;
    phraseTokens.add(token.start); phraseTokens.add(next.start);
    const prefix = token.raw === token.raw.toUpperCase() && next.raw === next.raw.toUpperCase()
      ? 'ПО-' : token.raw[0] === token.raw[0].toUpperCase() ? 'По-' : 'по-';
    add(token.start, next.end, prefix + next.raw, 'adverb-po-hyphen', 'spelling', 'Наречие с приставкой по- пишется через дефис.');
  }
  inspectDialogues();

  const list = (analyses, ruleId, predicates) => {
    for (let start = 0; start < tokens.length; start++) {
      if (!analyses(tokens[start]).length) continue;
      if (analyses === noun && tokens[start].analyses.some(item => /^(?:ADV|CONJ)$/u.test(item.tag))
        && tokens[start - 1]?.analyses.some(item => item.tag === 'ADV') && gap(tokens[start - 1], tokens[start])) continue;
      let end = start + 1;
      let shared = new Set(analyses(tokens[start]).map(item => predicates(item)));
      while (end < tokens.length && /^[\t \u00a0]*,?[\t \u00a0]+$/u.test(text.slice(tokens[end - 1].end, tokens[end].start))) {
        const options = new Set(analyses(tokens[end]).map(item => predicates(item)));
        const intersection = new Set([...shared].filter(value => options.has(value)));
        if (!intersection.size) break;
        shared = intersection; end++;
      }
      let repeatedContinuation = false;
      if (analyses === noun && end - start === 2 && tokens[start].word !== tokens[start + 1].word
        && tokens[end]?.word === 'и' && gap(tokens[end - 1], tokens[end])) {
        let head = end + 1;
        while (head < end + 5 && gap(tokens[head - 1], tokens[head]) && tokens[head].analyses.some(item => /^(?:ADV|PARTICLE)$/u.test(item.tag))) head++;
        const lemmas = new Set(noun(tokens[start]).map(item => item.lemma));
        repeatedContinuation = gap(tokens[head - 1], tokens[head]) && noun(tokens[head]).some(item => lemmas.has(item.lemma) && shared.has(predicates(item)));
      }
      if (end - start >= 3 || repeatedContinuation) {
        const chain = tokens.slice(start, end);
        const names = chain.every(token => noun(token).some(item => /:(?:Name|Patr|Fam)(?::|$)/u.test(item.tag)));
        const headFollows = analyses === adjective && gap(tokens[end - 1], tokens[end]) && noun(tokens[end]).length;
        if (!names && !headFollows) for (let index = start + 1; index < end; index++) markBetween(tokens[index - 1], tokens[index], ruleId);
      }
      start = end - 1;
    }
  };
  list(noun, 'noun-enumeration-comma', item => item.case || 'Nom');
  list(adjective, 'adjective-enumeration-comma', item => `${item.case}:${item.number}:${item.number === 'p' ? '' : item.gender}`);

  for (let start = 0; start < tokens.length - 2; start++) {
    let end = start + 1;
    while (end < tokens.length && tokens[end].word === tokens[start].word
      && /^[\t \u00a0]*,?[\t \u00a0]+$/u.test(text.slice(tokens[end - 1].end, tokens[end].start))) end++;
    if (end - start >= 3 && !finite(tokens[start])) {
      for (let index = start + 1; index < end; index++) markBetween(tokens[index - 1], tokens[index], 'emphatic-repetition-comma');
      start = end - 1;
    }
  }

  let first = 0;
  for (let end = 1; end <= tokens.length; end++) {
    if (end < tokens.length && !/[.!?;:\n]/u.test(text.slice(tokens[end - 1].end, tokens[end].start))) continue;
    const sentence = tokens.slice(first, end);
    if (interrogativeAdverbs.has(sentence[0]?.word) && sentence.some(item => predicate(item) || item.analyses.some(analysis => analysis.pos === 'verb'))
      && sentence.filter(finite).length <= 1) {
      const mainAfterComma = sentence.some((token, index) => {
        if (!index || !/,/u.test(text.slice(sentence[index - 1].end, token.start))) return false;
        const following = sentence.slice(index);
        return following.some(item => finite(item) || imperative(item) || item.analyses.some(analysis => analysis.tag === 'PRDC'))
          || following.some((item, position) => (nominative(item) || personalSubjects.has(item.word))
            && following.slice(position + 1).some(word => word.analyses.some(analysis => /^(?:ADJ:Short:|PT_Short:)/u.test(analysis.tag))));
      });
      const last = sentence.at(-1), tail = text.slice(last.end, tokens[end]?.start ?? text.length), period = /^[\t ]*\.(?=\s|$)/u.exec(tail);
      if (period && !mainAfterComma) add(last.start, last.end + period[0].length, last.raw + '?', 'direct-question-mark', 'punctuation', 'Прямой вопрос заканчивается вопросительным знаком.');
    }
    for (let index = first + 1; index < end; index++) {
      const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
      if (!gap(previous, token)) continue;
      const precedingPredicate = tokens.slice(first, index).some(predicate);
      const following = tokens.slice(index + 1, end);
      const predicateFollows = clausePredicate(following) || following.some(item => item.analyses.some(analysis => analysis.pos === 'verb' && analysis.tense === 'infinitive'));
      if (interrogativeAdverbs.has(token.word) && predicateFollows && tokens.slice(first, index).some(item => predicate(item) || imperative(item))) comma(previous.end, 'indirect-question-comma');
      if (clauseConjunctions.has(token.word) && precedingPredicate && predicateFollows
        && !['угодно', 'попало', 'бы'].includes(next?.word)) {
        let boundary = index - 1;
        if (['только', 'лишь', 'даже', 'особенно'].includes(previous.word) && boundary > first && gap(tokens[boundary - 1], previous)) boundary--;
        comma(tokens[boundary].end, 'subordinate-conjunction-comma');
      }
      if (token.word === 'что' && precedingPredicate && clausePredicate(following)
        && !['угодно', 'попало', 'либо', 'нибудь'].includes(next?.word)
        && !['потому', 'оттого', 'так', 'более'].includes(previous.word)) comma(previous.end, 'finite-complement-comma');
      if (token.word === 'особенно' && noun(previous).length && next && noun(next).length) comma(previous.end, 'attached-detail-comma');
    }
    for (let index = first; index < end; index++) {
      let head = index;
      while (head < end && addressModifier(tokens[head]) && gap(tokens[head], tokens[head + 1])) head++;
      if (head >= end || !nominative(tokens[head])) continue;
      if (authorRanges.some(([start, finish]) => tokens[head].start >= start && tokens[head].start < finish)) continue;
      let last = head;
      while (last + 1 < end && addressModifier(tokens[last + 1]) && gap(tokens[last], tokens[last + 1])) last++;
      const after = tokens[last + 1], before = tokens[index - 1];
      const animate = noun(tokens[head]).some(item => item.case === 'Nom' && /:(?:Anim|Name|Patr|Fam):/u.test(item.tag));
      const addressed = imperative(after) || ['ты', 'вы'].includes(after?.word) && tokens.slice(last + 2, end).some(item => finite(item) || imperative(item));
      if (index === first && addressed && (animate || last > head) && gap(tokens[last], after)) {
        comma(tokens[last].end, 'address-comma'); index = last; continue;
      }
      if (index > first && last === end - 1 && animate && sentence.some(imperative) && gap(before, tokens[index])) comma(before.end, 'address-comma');
      if (index === first + 1 && personalSubjects.has(tokens[first].word) && head > index
        && finite(after) && (gap(tokens[first], tokens[index]) || /^[\t ]*,[\t ]*$/u.test(text.slice(tokens[first].end, tokens[index].start))) && gap(tokens[last], after)) {
        comma(tokens[first].end, 'personal-pronoun-apposition'); comma(tokens[last].end, 'personal-pronoun-apposition');
      }
      index = last;
    }
    first = end;
  }

  function tokenIndexAt(offset) {
    let left = 0, right = tokens.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (tokens[middle].start < offset) left = middle + 1; else right = middle;
    }
    return left;
  }
  function tokenAt(offset) { return tokens[tokenIndexAt(offset)]; }
  function inspectDialogues() {
    for (const paragraph of text.matchAll(/[^\r\n]+/gu)) {
      const body = paragraph[0], origin = paragraph.index, opening = /^[\t ]*([—–-])[\t ]+/u.exec(body);
      const allCaps = !/\p{Ll}/u.test(body);
      if (!opening && !/^[\t ]*[«“]/u.test(body)) continue;
      const separators = [...body.matchAll(/[\t ]+([—–-])[\t ]+/gu)];
      for (let index = 0; index < separators.length; index++) {
        const separator = separators[index], dash = origin + separator.index + separator[0].indexOf(separator[1]);
        const authorStart = origin + separator.index + separator[0].length;
        const author = tokenAt(authorStart);
        if (!author || !finite(author)) continue;
        const authorIndex = tokenIndexAt(authorStart);
        let speakerIndex = authorIndex + 1;
        while (speakerIndex < authorIndex + 4 && gap(tokens[speakerIndex - 1], tokens[speakerIndex])
          && tokens[speakerIndex].analyses.some(item => /^(?:ADV|PARTICLE)$/u.test(item.tag))) speakerIndex++;
        const speaker = tokens[speakerIndex];
        const speakerSubject = personalSubjects.has(speaker?.word) || noun(speaker).some(item => item.case === 'Nom' && /:(?:Anim|Name|Patr|Fam):/u.test(item.tag));
        const utterance = tokens.slice(tokenIndexAt(origin), tokenIndexAt(origin + separator.index));
        const completeSpeech = utterance.some(item => predicate(item) || imperative(item) || personalSubjects.has(item.word) || noun(item).length || /^(?:INTJ|PARTICLE)$/u.test(item.analyses[0]?.tag || ''));
        if (!speakerSubject || !gap(tokens[speakerIndex - 1], speaker) || !completeSpeech) continue;
        if (opening?.[1] === '-') {
          const offset = origin + opening[0].indexOf('-');
          add(offset, offset + 1, '—', 'dialogue-dash', 'punctuation', 'Реплика начинается с тире.');
        }
        authorStarts.add(author.start);
        if (!allCaps && author.raw[0] !== author.raw[0].toLowerCase()) add(author.start, author.end, author.raw.toLowerCase(), 'dialogue-author-case', 'capitalization', 'Слова автора после реплики начинаются со строчной буквы.');
        if (separator[1] === '-') add(dash, dash + 1, '—', 'dialogue-dash', 'punctuation', 'Реплика и слова автора разделяются тире.');
        let finish = origin + separator.index;
        while (finish > origin && /[\t ]/u.test(text[finish - 1])) finish--;
        const punctuation = text[finish - 1];
        const quoted = /[»”]/u.test(punctuation), inside = quoted ? text[finish - 2] : punctuation;
        if (!/[,!?…]/u.test(inside)) {
          if (inside === '.' && interrogativeAdverbs.has(utterance[0]?.word)) add(finish - (quoted ? 2 : 1), finish - (quoted ? 1 : 0), '?', 'direct-question-mark');
          else if (inside === '.' && !quoted) add(finish - 1, finish, ',', 'dialogue-author-comma');
          else comma(finish, 'dialogue-author-comma');
        }
        const continuation = separators[index + 1];
        authorRanges.push([authorStart, continuation ? origin + continuation.index : origin + body.length]);
        if (continuation) {
          const nextStart = origin + continuation.index + continuation[0].length;
          const word = tokenAt(nextStart);
          let authorEnd = origin + continuation.index;
          while (authorEnd > authorStart && /[\t ]/u.test(text[authorEnd - 1])) authorEnd--;
          const terminal = text[authorEnd - 1];
          if (word && !/[,!?…\.]/u.test(terminal)) {
            if (word.raw[0] === word.raw[0].toLowerCase()) comma(authorEnd, 'dialogue-continuation-comma');
            else add(authorEnd, authorEnd, '.', 'dialogue-continuation-period');
          }
          if (!allCaps && word && terminal === ',' && word.raw[0] !== word.raw[0].toLowerCase() && !data.properForms.has(word.word)) add(word.start, word.end, word.raw.toLowerCase(), 'dialogue-continuation-case', 'capitalization', 'Продолжение одного предложения после слов автора начинается со строчной буквы.');
          if (continuation[1] === '-') {
            const offset = origin + continuation.index + continuation[0].indexOf('-');
            add(offset, offset + 1, '—', 'dialogue-dash', 'punctuation', 'После слов автора ставится тире.');
          }
        }
        break;
      }
    }
  }
  return { issues, commaPositions, phraseTokens, authorStarts };
}
