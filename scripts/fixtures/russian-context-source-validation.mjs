export const CONTEXT_SOURCE_VALIDATION = {
  'address-final-389': { originalGold: 'Помоги мне, иван.', gold: 'Помоги мне, Иван.', sourceTag: 'NN:Name:Masc:Sin:Nom' },
  'address-final-391': { originalGold: 'Помоги мне, анна.', gold: 'Помоги мне, Анна.', sourceTag: 'NN:Name:Fem:Sin:Nom' },
};
export function validatedContextCase(item) {
  const validation = CONTEXT_SOURCE_VALIDATION[item.id];
  return validation ? { ...item, gold: validation.gold, originalGold: validation.originalGold, validation: 'personal-name-capitalization' } : item;
}
export const CONTEXT_CONTROL_SOURCE_VALIDATION = {
  'Слово: иван.': { gold: 'Слово: Иван.', sourceTag: 'NN:Name:Masc:Sin:Nom' },
};
export function validatedContextControl(text) {
  return CONTEXT_CONTROL_SOURCE_VALIDATION[text]?.gold || text;
}
