const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Subsequence score: every query character must appear in order. Higher is better. */
export function fuzzyScore(query: string, text: string): number | undefined {
  const needle = normalize(query);
  const haystack = normalize(text);
  if (!needle) return undefined;

  let cursor = 0;
  let score = 0;
  let streak = 0;
  let previous = -2;
  for (const char of needle) {
    if (char === ' ') {
      streak = 0;
      continue;
    }
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return undefined;
    score += 1 + (index === 0 || haystack[index - 1] === ' ' ? 3 : 0);
    streak = index === previous + 1 ? streak + 1 : 0;
    score += streak * 2;
    previous = index;
    cursor = index + 1;
  }
  return score - haystack.length * 0.02;
}

/** Matches only, best first. */
export function fuzzySearch<T>(query: string, items: readonly T[], toText: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, toText(item)) }))
    .filter((entry): entry is { item: T; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}
