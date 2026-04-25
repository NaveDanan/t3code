import { createFileRoute } from "@tanstack/react-router";

import { BenchmarksSettings } from "../components/settings/BenchmarksSettings";

export const Route = createFileRoute("/settings/benchmarks")({
  validateSearch: (search) => ({
    runId: typeof search.runId === "string" && search.runId.length > 0 ? search.runId : undefined,
  }),
  component: BenchmarksSettings,
});
