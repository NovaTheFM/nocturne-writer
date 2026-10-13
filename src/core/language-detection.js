const ukrainian = new Set(['ми', 'ти', 'він', 'вона', 'вони', 'це', 'цей', 'ця', 'ці', 'але', 'що', 'його', 'немає']);
const russian = new Set(['мы', 'ты', 'он', 'она', 'они', 'это', 'этот', 'эта', 'эти', 'но', 'что', 'его', 'нет']);

export function inferLanguage(text) {
  if (/[іїєґІЇЄҐ]/u.test(text)) return 'uk';
  if (/[ъыэЪЫЭ]/u.test(text)) return 'ru';
  if (!/[а-яёА-ЯЁ]/u.test(text)) return 'en';
  let uk = 0, ru = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) || []) { uk += Number(ukrainian.has(word)); ru += Number(russian.has(word)); }
  return uk > ru ? 'uk' : 'ru';
}
