import { Alert, Card, Code, Loader, MultiSelect, Select, SimpleGrid, Stack, TagsInput, Text, TextInput, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorText } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";

export function ScopeStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();

  const trProjects = useQuery({
    enabled: profile.source === "testrail",
    queryKey: ["projects", "testrail", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkTestRail(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const toProjects = useQuery({
    queryKey: ["projects", "testops", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkTestOps(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const suites = useQuery({
    queryKey: ["suites", profile.id, profile.testrail.scope.projectId],
    queryFn: async () => {
      await flush();
      return api.testRailSuites(profile.id);
    },
    enabled: profile.source === "testrail" && Boolean(profile.testrail.scope.projectId),
  });

  const invalidateDiscovery = () => void queryClient.removeQueries({ queryKey: ["discovery"] });

  // Nothing to choose when there is only one project.
  useEffect(() => {
    const onlyTestRail = trProjects.data?.length === 1 ? trProjects.data[0]! : null;
    const onlyTestOps = toProjects.data?.length === 1 ? toProjects.data[0]! : null;
    if ((onlyTestRail && !profile.testrail.scope.projectId) || (onlyTestOps && !profile.testops.scope.projectId)) {
      update((p) => {
        if (onlyTestRail && !p.testrail.scope.projectId) {
          p.testrail.scope.projectId = onlyTestRail.id;
        }
        if (onlyTestOps && !p.testops.scope.projectId) {
          p.testops.scope.projectId = onlyTestOps.id;
        }
      });
    }
  }, [trProjects.data, toProjects.data, profile.testrail.scope.projectId, profile.testops.scope.projectId, update]);

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, lg: profile.source === "csv" ? 1 : 2 }} maw={profile.source === "csv" ? 640 : undefined}>
        {profile.source === "xray" && <XrayScopeCard onChange={invalidateDiscovery} />}
        {profile.source === "testrail" && (
        <Card withBorder>
          <Stack>
            <Title order={4}>From TestRail</Title>
            {trProjects.error && <Alert color="red">{errorText(trProjects.error)}</Alert>}
            <Select
              label="Project"
              placeholder={trProjects.isLoading ? "Loading…" : "Choose a project"}
              rightSection={trProjects.isLoading ? <Loader size={14} /> : undefined}
              searchable
              data={(trProjects.data ?? []).map((p) => ({ value: String(p.id), label: p.name }))}
              value={profile.testrail.scope.projectId ? String(profile.testrail.scope.projectId) : null}
              onChange={(value) => {
                update((p) => {
                  p.testrail.scope.projectId = value ? Number(value) : null;
                  p.testrail.scope.suiteIds = [];
                });
                invalidateDiscovery();
              }}
            />
            {suites.data && suites.data.suiteMode !== 1 && (
              <MultiSelect
                label="Suites"
                description="Leave empty to migrate all suites."
                placeholder={profile.testrail.scope.suiteIds.length ? undefined : "All suites"}
                searchable
                clearable
                data={suites.data.suites.map((s) => ({ value: String(s.id), label: s.name }))}
                value={profile.testrail.scope.suiteIds.map(String)}
                onChange={(values) => {
                  update((p) => void (p.testrail.scope.suiteIds = values.map(Number)));
                  invalidateDiscovery();
                }}
              />
            )}
            {suites.data?.suiteMode === 1 && (
              <Text size="sm" c="dimmed">
                This project uses a single repository without suites.
              </Text>
            )}
            {suites.error && <Alert color="red">{errorText(suites.error)}</Alert>}
            <TagsInput
              label="Only these cases (optional)"
              description="Case ids like 1234 or C1234, useful for a trial migration. Leave empty for everything."
              placeholder="Type an id and press Enter"
              value={profile.testrail.scope.caseIds.map((id) => `C${id}`)}
              onChange={(values) => {
                const ids = values.map((v) => Number(v.replace(/^C/i, "").trim())).filter((n) => Number.isInteger(n) && n > 0);
                update((p) => void (p.testrail.scope.caseIds = [...new Set(ids)]));
              }}
            />
          </Stack>
        </Card>
        )}
        <Card withBorder>
          <Stack>
            <Title order={4}>To Allure TestOps</Title>
            {toProjects.error && <Alert color="red">{errorText(toProjects.error)}</Alert>}
            <Select
              label="Project"
              placeholder={toProjects.isLoading ? "Loading…" : "Choose a project"}
              rightSection={toProjects.isLoading ? <Loader size={14} /> : undefined}
              searchable
              data={(toProjects.data ?? []).map((p) => ({ value: String(p.id), label: `${p.name} (#${p.id})` }))}
              value={profile.testops.scope.projectId ? String(profile.testops.scope.projectId) : null}
              onChange={(value) => {
                update((p) => void (p.testops.scope.projectId = value ? Number(value) : null));
                invalidateDiscovery();
              }}
            />
            <Text size="sm" c="dimmed">
              Test cases are created in this project. Running the migration again updates them instead of creating duplicates.
            </Text>
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

/** Jira project of the tests, an optional JQL filter and an optional list of tests for a trial run. */
function XrayScopeCard({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.xray.scope;
  const projects = useQuery({
    queryKey: ["projects", "xray", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkXray(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  useEffect(() => {
    const only = projects.data?.length === 1 ? projects.data[0]! : null;
    if (only?.key && !scope.projectKey) {
      update((p) => void (p.xray.scope.projectKey = only.key!));
    }
  }, [projects.data, scope.projectKey, update]);
  const [jql, setJql] = useState(scope.jql);

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>From Xray</Title>
        {projects.error && <Alert color="red">{errorText(projects.error)}</Alert>}
        <Select
          label="Jira project"
          placeholder={projects.isLoading ? "Loading…" : "Choose a project"}
          rightSection={projects.isLoading ? <Loader size={14} /> : undefined}
          searchable
          data={[
            ...(projects.data ?? []).filter((p) => p.key).map((p) => ({ value: p.key!, label: p.name })),
            ...(scope.projectKey && !projects.data?.some((p) => p.key === scope.projectKey) ? [{ value: scope.projectKey, label: scope.projectKey }] : []),
          ]}
          value={scope.projectKey || null}
          onChange={(value) => {
            update((p) => void (p.xray.scope.projectKey = value ?? ""));
            onChange();
          }}
        />
        <TextInput
          label="JQL filter (optional)"
          description={
            <>
              Narrows the Xray tests of the project, e.g. <Code>labels = regression</Code> or <Code>component = Checkout</Code>. Leave empty for all tests.
            </>
          }
          placeholder="labels = regression"
          value={jql}
          onChange={(e) => setJql(e.currentTarget.value)}
          onBlur={() => {
            if (jql !== scope.jql) {
              update((p) => void (p.xray.scope.jql = jql.trim()));
              onChange();
            }
          }}
        />
        <TagsInput
          label="Only these tests (optional)"
          description="Issue keys like CALC-12, useful for a trial migration. Leave empty for everything."
          placeholder="Type a key and press Enter"
          value={scope.issueKeys}
          onChange={(values) => update((p) => void (p.xray.scope.issueKeys = [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))]))}
        />
      </Stack>
    </Card>
  );
}
