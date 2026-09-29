import { Badge } from "@mantine/core";
import type { RunSummary } from "@atm/shared";

const COLORS: Record<RunSummary["status"], string> = {
  running: "blue",
  finished: "green",
  failed: "red",
  cancelled: "gray",
};

export function RunStatusBadge({ run }: { run: RunSummary }) {
  const label = run.status === "finished" && run.counters.failed > 0 ? `${run.counters.failed} failed` : run.status;
  const color = run.status === "finished" && run.counters.failed > 0 ? "orange" : COLORS[run.status];
  return (
    <Badge variant="light" color={color}>
      {run.dryRun ? "dry run · " : ""}
      {label}
    </Badge>
  );
}
