/**
 * Minimal LCS-based line diff for the side-by-side conflict resolver (D9/FR12).
 * Produces aligned rows so the UI can render two columns with changed lines
 * highlighted. Pure and testable.
 */
export interface DiffRow {
  left: string | null; // line from the "current" side (null = absent)
  right: string | null; // line from the "conflict copy" side (null = absent)
  changed: boolean;
}

export function lineDiff(aText: string, bText: string): DiffRow[] {
  const a = aText.split(/\r?\n/);
  const b = bText.split(/\r?\n/);
  const m = a.length;
  const n = b.length;

  // Longest-common-subsequence lengths (suffix DP).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ left: a[i], right: b[j], changed: false });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ left: a[i], right: null, changed: true });
      i++;
    } else {
      rows.push({ left: null, right: b[j], changed: true });
      j++;
    }
  }
  while (i < m) rows.push({ left: a[i++], right: null, changed: true });
  while (j < n) rows.push({ left: null, right: b[j++], changed: true });
  return rows;
}
