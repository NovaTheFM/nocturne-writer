export function findCorrectionPlan(issues, source, expected) {
  const starts = new Map();
  for (const issue of issues) {
    if (!Number.isInteger(issue.start) || !Number.isInteger(issue.end) || issue.start < 0 || issue.end < issue.start || issue.end > source.length) continue;
    if (!starts.has(issue.start)) starts.set(issue.start, []);
    starts.get(issue.start).push(issue);
  }
  const states = [{ source: 0, target: 0, previous: -1 }], visited = new Set(['0:0']);
  const push = (a, b, previous, issue, replacement) => {
    const key = `${a}:${b}`;
    if (visited.has(key)) return;
    visited.add(key); states.push({ source: a, target: b, previous, issue, replacement });
  };
  for (let index = 0; index < states.length && index < 400_000; index++) {
    const state = states[index];
    if (state.source === source.length && state.target === expected.length) {
      const plan = [];
      for (let cursor = index; cursor >= 0; cursor = states[cursor].previous) if (states[cursor].issue) plan.push({ ...states[cursor].issue, correct: states[cursor].replacement });
      return plan.reverse();
    }
    for (const issue of starts.get(state.source) || []) for (const replacement of issue.suggestions || (typeof issue.correct === 'string' ? [issue.correct] : [])) {
      if (typeof replacement === 'string' && expected.startsWith(replacement, state.target) && (issue.end !== state.source || replacement.length)) push(issue.end, state.target + replacement.length, index, issue, replacement);
    }
    if (state.source < source.length && state.target < expected.length && source[state.source] === expected[state.target]) push(state.source + 1, state.target + 1, index);
  }
  return null;
}

export function anyCorrectionPlan(issues, source, expectedVariants) {
  for (const expected of expectedVariants) {
    const plan = findCorrectionPlan(issues, source, expected);
    if (plan) return { expected, plan };
  }
  return null;
}
