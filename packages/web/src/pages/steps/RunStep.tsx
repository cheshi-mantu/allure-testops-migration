import {
  Alert,
  Anchor,
  Badge,
  Loader,
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
import { IconDownload, IconPlayerPlay, IconPlayerStop, IconTestPipe, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { runContextChanges, SECRET_MASK, type Profile, type RunLogEntry, type RunSummary } from "@atm/shared";
import { api, errorText } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";
import { FixButton, ProblemList } from "../../components/Problems";
import { RunStatusBadge } from "../../components/RunStatusBadge";

/** How the run's file, project or tag prefix differ from the profile now; empty when they match or are unknown. */
function otherSettings(run: RunSummary, profile: Profile, currentFileName: string | null): string[] {
  const context = run.context;
  if (!context) {
    return [];
  }
  return runContextChanges(context, profile).map((change) => {
    switch (change) {
      case "source":
        if (profile.source === "csv") {
          return `File "${context.sourceLabel}", the profile now uses ${currentFileName ? `"${currentFileName}"` : "another file"}.`;
        }
        if (profile.source === "xray") {
          const jql = profile.xray.scope.jql.trim();
          return `${context.sourceLabel}, the profile now uses Xray project ${profile.xray.scope.projectKey || "?"}${jql ? ` (${jql})` : ""}.`;
        }
        return `${context.sourceLabel}, the profile now uses TestRail project #${profile.testrail.scope.projectId ?? "?"}.`;
      case "project":
        return `Allure TestOps project #${context.testopsProjectId ?? "?"}, the profile now uses #${profile.testops.scope.projectId ?? "?"}.`;
      case "tagPrefix":
        return `Tag prefix "${context.tagPrefix}", the profile now uses ${profile.options.migrationTagPrefix ? `"${profile.options.migrationTagPrefix}"` : "none"}.`;
    }
  });
}

function problems(profile: Profile): string[] {
  const list: string[] = [];
  const has = (value: string) => value === SECRET_MASK || value.trim() !== "";
  if (!profile.testops.connection.endpoint || !has(profile.testops.connection.apiToken)) {
    list.push("The Allure TestOps connection is incomplete (Connections).");
  }
  if (!profile.options.migrationTagPrefix.trim()) {
    list.push("Enter the migration tag prefix (Options).");
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
  if (profile.source === "xray") {
    const c = profile.xray.connection;
    if (!c.jiraUrl || !c.jiraEmail || !has(c.jiraApiToken) || !c.clientId || !has(c.clientSecret)) {
      list.push("The Xray and Jira connection is incomplete (Connections).");
    }
    if (!profile.xray.scope.projectKey || !profile.testops.scope.projectId) {
      list.push("Choose both projects (Projects).");
    }
    if (profile.fields.length === 0) {
      list.push("Review the field mapping (Fields).");
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
    if (!profile.csv.withoutPath) {
      list.push("No section path column is chosen, so cases will not be grouped into sections.");
    }
  } else if (!profile.structure.levels.some(Boolean) && !profile.structure.suiteField) {
    list.push(
      profile.source === "xray"
        ? "No folder level is mapped, so the folders of the test repository will not be kept."
        : "No suite or section level is mapped, so the source structure will not be kept.",
    );
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
  const files = useQuery({ queryKey: ["files"], queryFn: api.files, enabled: profile.source === "csv" });
  const currentFileName = files.data?.find((f) => f.id === profile.csv.fileId)?.name ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const active = runs.data?.find((r) => r.status === "running") ?? null;
  const latest = runs.data?.[0] ?? null;
  const latestOther = latest ? otherSettings(latest, profile, currentFileName) : [];
  // A run made with another file, project or tag prefix says nothing about the current settings: show it only on request.
  const selected = runs.data?.find((r) => r.id === selectedId) ?? active ?? (latestOther.length === 0 ? latest : null);
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
  const clear = useMutation({
    mutationFn: () => api.clearRuns(profile.id),
    onSuccess: () => {
      setSelectedId(null);
      setConfirmClear(false);
      void queryClient.invalidateQueries({ queryKey: ["runs", profile.id] });
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });

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

      {!selected && latest && (
        <Alert color="gray" title="The last run used other settings">
          <Stack gap="xs">
            <List size="sm">
              {latestOther.map((line) => (
                <List.Item key={line}>{line}</List.Item>
              ))}
            </List>
            <Text size="sm">Its results do not describe the current settings. Start a dry run to check them.</Text>
            <Group>
              <Button size="xs" variant="default" onClick={() => setSelectedId(latest.id)}>
                Show that run
              </Button>
            </Group>
          </Stack>
        </Alert>
      )}

      {selected && <RunDetails key={selected.id} profile={profile} run={selected} other={otherSettings(selected, profile, currentFileName)} />}

      {(runs.data?.length ?? 0) > 0 && (
        <Card withBorder>
          <Group justify="space-between" mb="xs">
            <Title order={5}>History</Title>
            <Button size="xs" variant="subtle" color="red" leftSection={<IconTrash size={14} />} disabled={Boolean(active)} onClick={() => setConfirmClear(true)}>
              Clear history
            </Button>
          </Group>
          <Table.ScrollContainer minWidth={640}>
          <Table highlightOnHover verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Started</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Settings</Table.Th>
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
                  <Table.Td miw={170}>
                    <RunStatusBadge run={run} />
                  </Table.Td>
                  <Table.Td maw={320}>
                    {run.context ? (
                      <>
                        <Text size="sm" truncate title={run.context.sourceLabel}>
                          {run.context.sourceLabel}
                        </Text>
                        <Group gap={6}>
                          <Text size="xs" c="dimmed">
                            project #{run.context.testopsProjectId ?? "?"} · tag prefix{" "}
                            <Text span size="xs" className="mono">
                              {run.context.tagPrefix}
                            </Text>
                          </Text>
                          {otherSettings(run, profile, currentFileName).length > 0 && (
                            <Badge size="xs" variant="light" color="gray">
                              other settings
                            </Badge>
                          )}
                        </Group>
                      </>
                    ) : (
                      <Text size="xs" c="dimmed">
                        not recorded
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{run.counters.total}</Table.Td>
                  <Table.Td>
                    {run.dryRun ? "no changes" : `${run.counters.created} / ${run.counters.updated} / ${run.counters.failed}`}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          </Table.ScrollContainer>
        </Card>
      )}

      <Modal opened={confirmClear} onClose={() => setConfirmClear(false)} title="Clear the run history?">
        <Stack>
          <Text size="sm">
            The {runs.data?.length ?? 0} run(s) of this profile and their logs are deleted. Test cases in Allure TestOps are not touched.
          </Text>
          <Text size="sm" c="dimmed">
            The logs list the cases each run created, with links. Keep them while you may still need to find or remove those cases.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button color="red" loading={clear.isPending} onClick={() => clear.mutate()}>
              Clear history
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirm} onClose={() => setConfirm(false)} title="Start the migration?">
        <Stack>
          <Text size="sm">
            Test cases and custom fields{profile.source === "csv" ? "" : ", shared steps and attachments"} will be created or updated in
            Allure TestOps project #{profile.testops.scope.projectId}.{" "}
            {profile.source === "testrail" ? "TestRail is only read." : profile.source === "xray" ? "Jira and Xray are only read." : "The file is not changed."}
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

function RunDetails({ profile, run, other }: { profile: Profile; run: RunSummary; other: string[] }) {
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
  const jiraBase = profile.xray.connection.jiraUrl.replace(/\/?$/, "/");
  const testopsBase = profile.testops.connection.endpoint.replace(/\/?$/, "/");
  // Links point to the project the run wrote to, which may not be the one chosen now.
  const testopsProjectId = summary.context ? summary.context.testopsProjectId : profile.testops.scope.projectId;

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
              {summary.status === "running" ? "" : summary.phase}
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            {new Date(summary.startedAt).toLocaleString()}
            {summary.finishedAt ? ` – ${new Date(summary.finishedAt).toLocaleTimeString()}` : ""}
          </Text>
        </Group>
        {other.length > 0 && (
          <Alert color="gray" title="This run used other settings">
            <List size="sm">
              {other.map((line) => (
                <List.Item key={line}>{line}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Progress value={percent} animated={summary.status === "running"} striped={summary.status === "running"} size="lg" />
        {summary.status === "running" && (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" fw={500}>
              {summary.phase}
            </Text>
            {counters.total > 0 && counters.processed >= counters.total && (
              <Text size="sm" c="dimmed">
                all {counters.total} case(s) processed, finishing this step
              </Text>
            )}
          </Group>
        )}
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
          {counters.skipped > 0 && (
            <Badge variant="light" color="orange">
              {counters.skipped} {profile.source === "csv" ? "cannot be imported" : "skipped"}
            </Badge>
          )}
        </Group>
        {summary.error && (
          <Alert color="red" title={summary.status === "failed" ? "The run stopped" : "Error"}>
            <Stack gap="xs">
              <Text size="sm">{summary.error}</Text>
              {summary.errorHint && <Text size="sm">{summary.errorHint}</Text>}
              {summary.errorFix && (
                <Group>
                  <FixButton fix={summary.errorFix} />
                </Group>
              )}
            </Stack>
          </Alert>
        )}
        {(summary.problems?.length ?? 0) > 0 && (
          <Stack gap="xs">
            <Group justify="space-between">
              <Title order={5}>
                Problems ({summary.problems!.length})
              </Title>
              <Text size="xs" c="dimmed">
                Each problem says why it happens and where to fix it. Runs can be repeated: migrated cases are updated, not duplicated.
              </Text>
            </Group>
            <ProblemList problems={summary.problems!} />
          </Stack>
        )}
        {summary.status !== "running" && (summary.problems?.length ?? 0) === 0 && !summary.error && (
          <Alert color="green" variant="light">
            No problems found.
          </Alert>
        )}
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
          <Button
            size="xs"
            variant="default"
            component="a"
            href={api.runLogUrl(profile.id, summary.id)}
            leftSection={<IconDownload size={14} />}
          >
            Download log
          </Button>
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
                  ) : profile.source === "xray" && /^[A-Z][A-Z0-9_]*-\d+$/.test(entry.caseId) ? (
                    <Anchor href={`${jiraBase}browse/${entry.caseId}`} target="_blank" size="xs" className="mono">
                      {entry.caseId}
                    </Anchor>
                  ) : (
                    <Text span size="xs" className="mono" c="dimmed">
                      [{entry.caseId}]
                    </Text>
                  ))}
                {entry.caseId !== undefined && " "}
                {entry.message}
                {entry.targetId !== undefined && testopsProjectId && (
                  <>
                    {" "}
                    <Anchor
                      href={`${testopsBase}project/${testopsProjectId}/test-cases/${entry.targetId}`}
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
