import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Modal,
  Progress,
  ScrollArea,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconPlayerPlay, IconPlayerStop, IconTestPipe } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { SECRET_MASK, type Profile, type RunLogEntry, type RunSummary } from "@atm/shared";
import { api, errorText } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";
import { RunStatusBadge } from "../../components/RunStatusBadge";

function problems(profile: Profile): string[] {
  const list: string[] = [];
  const has = (value: string) => value === SECRET_MASK || value.trim() !== "";
  if (!profile.testops.connection.endpoint || !has(profile.testops.connection.apiToken)) {
    list.push("The Allure TestOps connection is incomplete (Connections).");
  }
  if (profile.source === "csv") {
    if (!profile.csv.fileId) {
      list.push("Choose a CSV file (CSV file).");
    }
    if (!profile.testops.scope.projectId) {
      list.push("Choose the Allure TestOps project (Project).");
    }
    const names = profile.fields.filter((m) => m.target.kind === "name").length;
    if (names !== 1) {
      list.push("Map exactly one column to the test case name (Columns).");
    }
    return list;
  }
  if (!profile.testrail.connection.endpoint || !has(profile.testrail.connection.apiKey)) {
    list.push("The TestRail connection is incomplete (Connections).");
  }
  if (!profile.testrail.scope.projectId || !profile.testops.scope.projectId) {
    list.push("Choose both projects (Projects).");
  }
  if (profile.fields.length === 0) {
    list.push("Review the field mapping (Fields).");
  }
  return list;
}

function warnings(profile: Profile): string[] {
  const list: string[] = [];
  if (profile.source === "csv" && !profile.csv.pathColumn) {
    list.push("No section path column is chosen, so cases will not be grouped into sections.");
  } else if (!profile.structure.levels.some(Boolean) && !profile.structure.suiteField) {
    list.push("No suite or section level is mapped, so the source structure will not be kept.");
  }
  if (profile.fields.some((m) => m.target.kind === "role" && !m.target.role)) {
    list.push("A column maps to members without a role; those members will be skipped.");
  }
  if (profile.fields.some((m) => m.target.kind === "issue" && m.target.integrationId === null)) {
    list.push("A field maps to issues without an issue tracker integration; those issues will be skipped.");
  }
  if (!profile.fields.some((m) => m.target.kind === "scenario")) {
    list.push("No field maps to the scenario, so steps will not be migrated.");
  }
  return list;
}

const LEVEL_COLORS: Record<RunLogEntry["level"], string | undefined> = {
  debug: "dimmed",
  info: undefined,
  warn: "orange",
  error: "red",
};

function useRunStream(profileId: string, run: RunSummary | null) {
  const queryClient = useQueryClient();
  const [entries, setEntries] = useState<RunLogEntry[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(run);
  useEffect(() => {
    setEntries([]);
    setSummary(run);
    if (!run) {
      return;
    }
    const source = new EventSource(api.runEventsUrl(profileId, run.id));
    source.addEventListener("log", (event) => {
      const entry = JSON.parse((event as MessageEvent<string>).data) as RunLogEntry;
      setEntries((list) => (list.length > 0 && list[list.length - 1]!.seq >= entry.seq ? list : [...list, entry]));
    });
    source.addEventListener("summary", (event) => {
      const next = JSON.parse((event as MessageEvent<string>).data) as RunSummary | null;
      if (next) {
        setSummary(next);
      }
    });
    source.addEventListener("end", () => {
      source.close();
      void queryClient.invalidateQueries({ queryKey: ["runs", profileId] });
    });
    return () => source.close();
    // Reconnect only when a different run is shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, run?.id]);
  return { entries, summary };
}

export function RunStep() {
  const { profile, flush } = useProfile();
  const queryClient = useQueryClient();
  const runs = useQuery({ queryKey: ["runs", profile.id], queryFn: () => api.runs(profile.id), refetchInterval: 10_000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const selected = runs.data?.find((r) => r.id === selectedId) ?? runs.data?.[0] ?? null;
  const active = runs.data?.find((r) => r.status === "running") ?? null;
  const blockers = problems(profile);
  const hints = warnings(profile);

  const start = useMutation({
    mutationFn: async (dryRun: boolean) => {
      await flush();
      return api.startRun(profile.id, dryRun);
    },
    onSuccess: (run) => {
      setSelectedId(run.id);
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ["runs", profile.id] });
    },
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });
  const cancel = useMutation({ mutationFn: () => api.cancelRun(profile.id) });

  return (
    <Stack>
      {blockers.length > 0 && (
        <Alert color="red" title="Not ready yet">
          <List size="sm">
            {blockers.map((b) => (
              <List.Item key={b}>{b}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {blockers.length === 0 && hints.length > 0 && (
        <Alert color="yellow" title="Check before running">
          <List size="sm">
            {hints.map((h) => (
              <List.Item key={h}>{h}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      <Card withBorder>
        <Group justify="space-between">
          <div>
            <Title order={4}>Run the migration</Title>
            <Text size="sm" c="dimmed" maw={620}>
              A dry run reads every case and converts it without writing anything, showing problems up front. The migration can be
              run again at any time: already migrated cases are updated, not duplicated.
            </Text>
          </div>
          <Group>
            {active ? (
              <Button color="red" variant="light" leftSection={<IconPlayerStop size={16} />} loading={cancel.isPending} onClick={() => cancel.mutate()}>
                Stop
              </Button>
            ) : (
              <>
                <Button
                  variant="default"
                  leftSection={<IconTestPipe size={16} />}
                  disabled={blockers.length > 0}
                  loading={start.isPending && start.variables === true}
                  onClick={() => start.mutate(true)}
                >
                  Dry run
                </Button>
                <Button leftSection={<IconPlayerPlay size={16} />} disabled={blockers.length > 0} onClick={() => setConfirm(true)}>
                  Start migration
                </Button>
              </>
            )}
          </Group>
        </Group>
      </Card>

      {selected && <RunDetails key={selected.id} profile={profile} run={selected} />}

      {(runs.data?.length ?? 0) > 0 && (
        <Card withBorder>
          <Title order={5} mb="xs">
            History
          </Title>
          <Table highlightOnHover verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Started</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Cases</Table.Th>
                <Table.Th>Created / updated / failed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runs.data!.map((run) => (
                <Table.Tr
                  key={run.id}
                  style={{ cursor: "pointer" }}
                  bg={run.id === selected?.id ? "var(--mantine-color-blue-light)" : undefined}
                  onClick={() => setSelectedId(run.id)}
                >
                  <Table.Td>{new Date(run.startedAt).toLocaleString()}</Table.Td>
                  <Table.Td>
                    <RunStatusBadge run={run} />
                  </Table.Td>
                  <Table.Td>{run.counters.total}</Table.Td>
                  <Table.Td>
                    {run.dryRun ? "no changes" : `${run.counters.created} / ${run.counters.updated} / ${run.counters.failed}`}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <Modal opened={confirm} onClose={() => setConfirm(false)} title="Start the migration?">
        <Stack>
          <Text size="sm">
            Test cases and custom fields{profile.source === "testrail" ? ", shared steps and attachments" : ""} will be created or updated in
            Allure TestOps project #{profile.testops.scope.projectId}. {profile.source === "testrail" ? "TestRail is only read." : "The file is not changed."}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button loading={start.isPending} onClick={() => start.mutate(false)}>
              Start migration
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

type LogFilter = "all" | "problems" | "errors";

function RunDetails({ profile, run }: { profile: Profile; run: RunSummary }) {
  const { entries, summary: live } = useRunStream(profile.id, run);
  const summary = live ?? run;
  const [filter, setFilter] = useState<LogFilter>("all");
  const viewport = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () => entries.filter((e) => filter === "all" || (filter === "errors" ? e.level === "error" : e.level === "warn" || e.level === "error")),
    [entries, filter],
  );
  const counters = summary.counters;
  const percent = counters.total ? Math.round((counters.processed / counters.total) * 100) : summary.status === "running" ? 0 : 100;
  const testrailBase = profile.testrail.connection.endpoint.replace(/\/?$/, "/");
  const testopsBase = profile.testops.connection.endpoint.replace(/\/?$/, "/");

  useEffect(() => {
    if (filter === "all" && viewport.current) {
      viewport.current.scrollTo({ top: viewport.current.scrollHeight });
    }
  }, [shown.length, filter]);

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Group gap="xs">
            <Title order={5}>{summary.dryRun ? "Dry run" : "Migration"}</Title>
            <RunStatusBadge run={summary} />
            <Text size="sm" c="dimmed">
              {summary.phase}
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            {new Date(summary.startedAt).toLocaleString()}
            {summary.finishedAt ? ` – ${new Date(summary.finishedAt).toLocaleTimeString()}` : ""}
          </Text>
        </Group>
        <Progress value={percent} animated={summary.status === "running"} size="lg" />
        <Group gap="xs">
          <Badge variant="light">{counters.processed} / {counters.total} processed</Badge>
          {!summary.dryRun && (
            <>
              <Badge variant="light" color="green">{counters.created} created</Badge>
              <Badge variant="light" color="blue">{counters.updated} updated</Badge>
            </>
          )}
          <Badge variant="light" color={counters.failed ? "red" : "gray"}>
            {counters.failed} failed
          </Badge>
          {counters.skipped > 0 && !summary.dryRun && <Badge variant="light" color="gray">{counters.skipped} skipped</Badge>}
        </Group>
        {summary.error && <Alert color="red">{summary.error}</Alert>}
        <Group justify="space-between">
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(value) => setFilter(value as LogFilter)}
            data={[
              { value: "all", label: `All (${entries.length})` },
              { value: "problems", label: `Warnings & errors (${entries.filter((e) => e.level === "warn" || e.level === "error").length})` },
              { value: "errors", label: `Errors (${entries.filter((e) => e.level === "error").length})` },
            ]}
          />
        </Group>
        <ScrollArea h={360} viewportRef={viewport} type="auto">
          <Stack gap={2}>
            {shown.map((entry) => (
              <Text key={entry.seq} size="xs" className="mono log-line" c={LEVEL_COLORS[entry.level]}>
                {new Date(entry.time).toLocaleTimeString()}{" "}
                {entry.caseId !== undefined &&
                  (profile.source === "testrail" ? (
                    <Anchor href={`${testrailBase}index.php?/cases/view/${entry.caseId}`} target="_blank" size="xs" className="mono">
                      C{entry.caseId}
                    </Anchor>
                  ) : (
                    <Text span size="xs" className="mono" c="dimmed">
                      [{entry.caseId}]
                    </Text>
                  ))}
                {entry.caseId !== undefined && " "}
                {entry.message}
                {entry.targetId !== undefined && profile.testops.scope.projectId && (
                  <>
                    {" "}
                    <Anchor
                      href={`${testopsBase}project/${profile.testops.scope.projectId}/test-cases/${entry.targetId}`}
                      target="_blank"
                      size="xs"
                      className="mono"
                    >
                      → #{entry.targetId}
                    </Anchor>
                  </>
                )}
              </Text>
            ))}
            {shown.length === 0 && (
              <Text size="xs" c="dimmed">
                Nothing to show.
              </Text>
            )}
          </Stack>
        </ScrollArea>
      </Stack>
    </Card>
  );
}
