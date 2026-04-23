import { createFileRoute } from "@tanstack/react-router";

import { BenchmarksSettings } from "../components/settings/BenchmarksSettings";

export const Route = createFileRoute("/settings/benchmarks")({
  component: BenchmarksSettings,
});
