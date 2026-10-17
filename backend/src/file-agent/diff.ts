// Day 34: unified diff of two versions of a file, for showing the file
// agent's proposed changes (same shape as `git diff`, so it can be applied
// with `git apply`). Common head and tail are cut first; the changed middle
// is compared line by line (LCS), which is plenty for files of a few thousand
// lines with local edits.

export interface DiffStats {
  additions: number;
  deletions: number;
}

type Op = { kind: ' ' | '-' | '+'; text: string };

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // LCS table over the changed middle only.
  const n = midA.length;
  const m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, start).map((text) => ({ kind: ' ', text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      ops.push({ kind: ' ', text: midA[i++] });
      j++;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // Deletions before additions, as git shows a replaced line.
      ops.push({ kind: '-', text: midA[i++] });
    } else {
      ops.push({ kind: '+', text: midB[j++] });
    }
  }
  ops.push(...a.slice(endA).map((text) => ({ kind: ' ' as const, text })));
  return ops;
}

const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));

/**
 * `before` undefined = a new file. Returns the diff text (with `diff --git`
 * headers) and +/- counts; an empty string when nothing changed.
 */
export function unifiedDiff(file: string, before: string | undefined, after: string, context = 3): { diff: string } & DiffStats {
  const a = split(before ?? '');
  const b = split(after);
  const ops = lineOps(a, b);
  const additions = ops.filter((o) => o.kind === '+').length;
  const deletions = ops.filter((o) => o.kind === '-').length;
  if (!additions && !deletions && before !== undefined) return { diff: '', additions, deletions };

  const header = [
    `diff --git a/${file} b/${file}`,
    ...(before === undefined ? ['new file mode 100644', '--- /dev/null'] : [`--- a/${file}`]),
    `+++ b/${file}`,
  ];
  // Group changes into hunks with `context` lines around them.
  const hunks: string[] = [];
  let k = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions = ops.map((o) => {
    const p = { o, oldLine, newLine };
    if (o.kind !== '+') oldLine++;
    if (o.kind !== '-') newLine++;
    return p;
  });
  while (k < positions.length) {
    while (k < positions.length && positions[k].o.kind === ' ') k++;
    if (k >= positions.length) break;
    const from = Math.max(0, k - context);
    let to = k;
    // Extend while the next change is within 2*context unchanged lines.
    for (;;) {
      while (to < positions.length && positions[to].o.kind !== ' ') to++;
      let gap = to;
      while (gap < positions.length && positions[gap].o.kind === ' ' && gap - to < 2 * context) gap++;
      if (gap < positions.length && positions[gap].o.kind !== ' ') to = gap;
      else break;
    }
    const end = Math.min(positions.length, to + context);
    const slice = positions.slice(from, end);
    const oldCount = slice.filter((p) => p.o.kind !== '+').length;
    const newCount = slice.filter((p) => p.o.kind !== '-').length;
    const oldStart = oldCount ? slice.find((p) => p.o.kind !== '+')!.oldLine : Math.max(0, slice[0].oldLine - 1);
    const newStart = newCount ? slice.find((p) => p.o.kind !== '-')!.newLine : Math.max(0, slice[0].newLine - 1);
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map((p) => `${p.o.kind}${p.o.text}`));
    k = end;
  }
  return { diff: [...header, ...hunks].join('\n'), additions, deletions };
}
