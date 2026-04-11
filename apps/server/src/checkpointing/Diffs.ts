import { parseUnifiedDiffFiles } from "@t3tools/shared/diff";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  return parseUnifiedDiffFiles(diff).map(({ path, additions, deletions }) => ({
    path,
    additions,
    deletions,
  }));
}
