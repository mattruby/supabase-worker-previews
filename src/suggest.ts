/** The candidate closest to `input` by edit distance, if it is close enough to be a typo. */
export function didYouMean(input: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const [a, b] = [input.toLowerCase(), c.toLowerCase()];
    const d = b.startsWith(a) && a.length >= 2 ? 0 : distance(a, b);
    if (d < bestDistance) [best, bestDistance] = [c, d];
  }
  return bestDistance <= Math.max(1, Math.floor((best?.length ?? 0) / 3)) ? best : undefined;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}
