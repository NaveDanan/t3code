import type { TerminalLaunchProfile } from "@t3tools/contracts";

export function buildTerminalLabelById(input: {
  terminalIds: readonly string[];
  terminalLaunchProfilesById: Readonly<Record<string, TerminalLaunchProfile | undefined>>;
}): ReadonlyMap<string, string> {
  const baseLabels = input.terminalIds.map((terminalId, index) => {
    const launchProfile = input.terminalLaunchProfilesById[terminalId];
    return launchProfile?.label ?? `Terminal ${index + 1}`;
  });
  const labelCounts = new Map<string, number>();
  for (const label of baseLabels) {
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }

  const seenCounts = new Map<string, number>();
  return new Map(
    input.terminalIds.map((terminalId, index) => {
      const baseLabel = baseLabels[index] ?? `Terminal ${index + 1}`;
      const duplicateCount = labelCounts.get(baseLabel) ?? 0;
      if (duplicateCount <= 1) {
        return [terminalId, baseLabel] as const;
      }
      const instance = (seenCounts.get(baseLabel) ?? 0) + 1;
      seenCounts.set(baseLabel, instance);
      return [terminalId, `${baseLabel} ${instance}`] as const;
    }),
  );
}

export function buildRunningTerminalStatusLabel(input: {
  runningTerminalIds: readonly string[];
  terminalLabelById: ReadonlyMap<string, string>;
}): string {
  const labels = input.runningTerminalIds.map(
    (terminalId) => input.terminalLabelById.get(terminalId) ?? terminalId,
  );
  if (labels.length === 1) {
    return `Running terminal: ${labels[0]}`;
  }
  return `Running terminals: ${labels.join(", ")}`;
}
