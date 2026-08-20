/**
 * Согласование числа со словом.
 *
 * «1 комментарий готов», «2 комментария готовы», «5 комментариев готовы» — интерфейс, который
 * пишет «5 комментарий», выглядит недоделанным. Правило одно на все поверхности продукта, поэтому
 * живёт в ядре: тексты плагина и десктопа должны совпадать дословно.
 */
export function russianCountForm(count: number, one: string, few: string, many: string): string {
  const lastTwo = Math.abs(count) % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = lastTwo % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
