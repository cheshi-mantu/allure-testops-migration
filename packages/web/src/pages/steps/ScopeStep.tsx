import { Alert, Card, Loader, MultiSelect, Select, SimpleGrid, Stack, TagsInput, Text, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, errorText } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";

export function ScopeStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();

  const trProjects = useQuery({
    enabled: profile.source !== "csv",
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
    enabled: profile.source !== "csv" && Boolean(profile.testrail.scope.projectId),
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
        {profile.source !== "csv" && (
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
