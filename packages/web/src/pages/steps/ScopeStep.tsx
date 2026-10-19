import { Alert, Button, Card, Checkbox, Code, Group, Loader, MultiSelect, Select, SimpleGrid, Stack, Table, TagsInput, Text, TextInput, Title } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isFileSource } from "@atm/shared";
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

  if (profile.source === "testops") {
    return <TestOpsSourceScope onChange={invalidateDiscovery} />;
  }

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, lg: isFileSource(profile.source) ? 1 : 2 }} maw={isFileSource(profile.source) ? 640 : undefined}>
        {profile.source === "xray" && <XrayScopeCard onChange={invalidateDiscovery} />}
        {profile.source === "zephyr" && <ZephyrScopeCard onChange={invalidateDiscovery} />}
        {profile.source === "squad" && <SquadScopeCard onChange={invalidateDiscovery} />}
        {profile.source === "qase" && <QaseScopeCard onChange={invalidateDiscovery} />}
        {profile.source === "alm" && <AlmScopeCard onChange={invalidateDiscovery} />}
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

/**
 * Projects of the source Allure TestOps, each with the name of its project in the target, and the
 * integrations of the target their issues and test keys go through.
 */
function TestOpsSourceScope({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.testopsSource;
  const projects = useQuery({
    queryKey: ["projects", "testops-source", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkTestOpsSource(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const chosen = scope.projects.map((p) => p.sourceId).join(",");
  const integrations = useQuery({
    queryKey: ["integrations", "testops-source", profile.id, chosen],
    queryFn: async () => {
      await flush();
      return api.testOpsSourceIntegrations(profile.id);
    },
    enabled: scope.projects.length > 0,
  });
  // Suggested integrations become the mapping until the user changes them.
  useEffect(() => {
    const missing = (integrations.data?.source ?? []).filter((i) => !(String(i.id) in scope.integrations) && i.suggested);
    if (missing.length > 0) {
      update((p) => missing.forEach((i) => (p.testopsSource.integrations[String(i.id)] = i.suggested)));
    }
  }, [integrations.data, scope.integrations, update]);

  return (
    <Stack>
      <Card withBorder>
        <Stack>
          <Title order={4}>Projects to copy</Title>
          <Text size="sm" c="dimmed">
            Each project goes into a project of the target with the name below: the project is created on the first run and found by its name
            on the next ones, which update the cases instead of duplicating them.
          </Text>
          {projects.error && <Alert color="red">{errorText(projects.error)}</Alert>}
          <MultiSelect
            label="Projects of the source Allure TestOps"
            placeholder={projects.isLoading ? "Loading…" : scope.projects.length ? undefined : "Choose projects"}
            searchable
            clearable
            data={(projects.data ?? []).map((p) => ({ value: String(p.id), label: `${p.name} (#${p.id})` }))}
            value={scope.projects.map((p) => String(p.sourceId))}
            onChange={(values) => {
              update((p) => {
                const kept = new Map(p.testopsSource.projects.map((pair) => [String(pair.sourceId), pair]));
                p.testopsSource.projects = values.map((value) => {
                  const known = kept.get(value);
                  const name = projects.data?.find((project) => String(project.id) === value)?.name ?? known?.sourceName ?? value;
                  return known ?? { sourceId: Number(value), sourceName: name, targetName: name };
                });
              });
              onChange();
            }}
          />
          {scope.projects.length > 0 && (
            <Table verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Source project</Table.Th>
                  <Table.Th>Project in the target</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {scope.projects.map((pair, index) => (
                  <Table.Tr key={pair.sourceId}>
                    <Table.Td>
                      {pair.sourceName} <Text span size="xs" c="dimmed">#{pair.sourceId}</Text>
                    </Table.Td>
                    <Table.Td>
                      <TextInput
                        aria-label={`Target project for ${pair.sourceName}`}
                        value={pair.targetName}
                        error={pair.targetName.trim() ? undefined : "Enter a name"}
                        onChange={(e) => {
                          const value = e.currentTarget.value;
                          update((p) => void (p.testopsSource.projects[index]!.targetName = value));
                        }}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          <div>
            <Text size="sm" fw={500}>
              Test cases to migrate
            </Text>
            <Group gap="lg" mt={6}>
              <Checkbox
                label="Manual"
                checked={scope.manual}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  update((p) => void (p.testopsSource.manual = checked));
                  onChange();
                }}
              />
              <Checkbox
                label="Automated"
                checked={scope.automated}
                onChange={(e) => {
                  const checked = e.currentTarget.checked;
                  update((p) => void (p.testopsSource.automated = checked));
                  onChange();
                }}
              />
            </Group>
            <Text size="xs" c={scope.manual || scope.automated ? "dimmed" : "red"} mt={4}>
              {scope.manual || scope.automated ? "By the Automated flag of the test case in the source." : "Choose manual or automated test cases, or both."}
            </Text>
          </div>
          <TagsInput
            label="Only these test cases (optional)"
            description="Ids of test cases in the source, for a trial run. Leave empty for every case of the chosen projects."
            placeholder="Type an id and press Enter"
            value={scope.caseIds.map(String)}
            onChange={(values) => {
              const ids = values.map((value) => Number(value.replace(/^#/, ""))).filter((id) => Number.isInteger(id) && id > 0);
              update((p) => void (p.testopsSource.caseIds = [...new Set(ids)]));
              onChange();
            }}
          />
        </Stack>
      </Card>

      {scope.projects.length > 0 && (
        <Card withBorder>
          <Stack>
            <Title order={4}>Integrations</Title>
            <Text size="sm" c="dimmed">
              Issues and test keys of a case belong to an integration (Jira, YouTrack…). Choose the integration of the target each of them goes
              through; the migration adds it to the target project. Credentials of integrations cannot be copied: if the target has no such
              integration yet, an administrator sets it up in the target (Administration, Integrations), then reload this list.
            </Text>
            {integrations.isLoading && <Loader size="sm" />}
            {integrations.error && <Alert color="red">{errorText(integrations.error)}</Alert>}
            {integrations.data && integrations.data.source.length === 0 && <Text size="sm">The chosen projects use no integrations.</Text>}
            {integrations.data && integrations.data.source.length > 0 && (
              <Table verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>In the source</Table.Th>
                    <Table.Th>In the target</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {integrations.data.source.map((integration) => {
                    const value = scope.integrations[String(integration.id)];
                    return (
                      <Table.Tr key={integration.id}>
                        <Table.Td>
                          <Text size="sm" fw={500}>
                            {integration.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {[integration.type, integration.projects.join(", ")].filter(Boolean).join(" · ")}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Select
                            aria-label={`Target integration for ${integration.name}`}
                            allowDeselect={false}
                            data={[
                              { value: "", label: "Do not migrate its issues and test keys" },
                              ...integrations.data!.target.map((t) => ({ value: String(t.id), label: `${t.name}${t.type ? ` (${t.type})` : ""}` })),
                            ]}
                            value={value ? String(value) : ""}
                            error={value ? undefined : integrations.data!.target.length === 0 ? "The target has no integrations yet" : undefined}
                            onChange={(next) => update((p) => void (p.testopsSource.integrations[String(integration.id)] = next ? Number(next) : null))}
                          />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            )}
            <Group>
              <Button variant="light" size="xs" loading={integrations.isFetching} onClick={() => void integrations.refetch()}>
                Reload integrations
              </Button>
            </Group>
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

/** Qase project, optionally some of its suites, and an optional list of cases for a trial run. */
function QaseScopeCard({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.qase.scope;
  const projects = useQuery({
    queryKey: ["projects", "qase", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkQase(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const suites = useQuery({
    queryKey: ["suites", "qase", profile.id, scope.projectCode],
    queryFn: async () => {
      await flush();
      return api.qaseSuites(profile.id);
    },
    enabled: Boolean(scope.projectCode),
  });
  useEffect(() => {
    const only = projects.data?.length === 1 ? projects.data[0]! : null;
    if (only?.key && !scope.projectCode) {
      update((p) => void (p.qase.scope.projectCode = only.key!));
    }
  }, [projects.data, scope.projectCode, update]);

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>From Qase</Title>
        {projects.error && <Alert color="red">{errorText(projects.error)}</Alert>}
        <Select
          label="Project"
          placeholder={projects.isLoading ? "Loading…" : "Choose a project"}
          rightSection={projects.isLoading ? <Loader size={14} /> : undefined}
          searchable
          data={[
            ...(projects.data ?? []).filter((p) => p.key).map((p) => ({ value: p.key!, label: p.name })),
            ...(scope.projectCode && !projects.data?.some((p) => p.key === scope.projectCode) ? [{ value: scope.projectCode, label: scope.projectCode }] : []),
          ]}
          value={scope.projectCode || null}
          onChange={(value) => {
            update((p) => {
              p.qase.scope.projectCode = value ?? "";
              p.qase.scope.suiteIds = [];
              p.qase.scope.caseIds = [];
            });
            onChange();
          }}
        />
        <MultiSelect
          label="Suites (optional)"
          description="Only the cases of these suites and of the suites inside them. Leave empty for the whole project."
          placeholder={suites.isLoading ? "Loading…" : scope.suiteIds.length ? undefined : "All suites"}
          searchable
          clearable
          disabled={!scope.projectCode}
          data={(suites.data ?? []).map((suite) => ({ value: String(suite.id), label: suite.name }))}
          value={scope.suiteIds.map(String)}
          onChange={(values) => {
            update((p) => void (p.qase.scope.suiteIds = values.map(Number)));
            onChange();
          }}
        />
        <TagsInput
          label="Only these cases (optional)"
          description={`Case ids like 12 or ${scope.projectCode || "DEMO"}-12, useful for a trial migration. Leave empty for everything.`}
          placeholder="Type an id and press Enter"
          value={scope.caseIds.map(String)}
          onChange={(values) => {
            const ids = values.map((value) => Number(/(\d+)\s*$/.exec(value)?.[1])).filter((id) => Number.isInteger(id) && id > 0);
            update((p) => void (p.qase.scope.caseIds = [...new Set(ids)]));
            onChange();
          }}
        />
      </Stack>
    </Card>
  );
}

/** ALM domain and project, optionally some Test Plan folders, and an optional list of tests for a trial run. */
function AlmScopeCard({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.alm.scope;
  const projects = useQuery({
    queryKey: ["projects", "alm", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkAlm(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const folders = useQuery({
    queryKey: ["folders", "alm", profile.id, scope.domain, scope.project],
    queryFn: async () => {
      await flush();
      return api.almFolders(profile.id);
    },
    enabled: Boolean(scope.domain && scope.project),
  });
  // A domain and a project in one value of the list.
  const valueOf = (domain: string, project: string) => JSON.stringify([domain, project]);
  useEffect(() => {
    const only = projects.data?.length === 1 ? projects.data[0]! : null;
    if (only?.key && !scope.project) {
      update((p) => {
        p.alm.scope.domain = only.key!;
        p.alm.scope.project = only.name;
      });
    }
  }, [projects.data, scope.project, update]);
  const domains = [...new Set((projects.data ?? []).map((p) => p.key ?? ""))];
  const current = scope.domain && scope.project ? valueOf(scope.domain, scope.project) : null;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>From ALM</Title>
        {projects.error && <Alert color="red">{errorText(projects.error)}</Alert>}
        <Select
          label="Project"
          description="Projects of the domains the user can open."
          placeholder={projects.isLoading ? "Loading…" : "Choose a project"}
          rightSection={projects.isLoading ? <Loader size={14} /> : undefined}
          searchable
          data={[
            ...domains.map((domain) => ({
              group: domain,
              items: (projects.data ?? []).filter((p) => p.key === domain).map((p) => ({ value: valueOf(domain, p.name), label: p.name })),
            })),
            ...(current && !projects.data?.some((p) => p.key === scope.domain && p.name === scope.project) ? [{ value: current, label: `${scope.domain} / ${scope.project}` }] : []),
          ]}
          value={current}
          onChange={(value) => {
            const [domain, project] = value ? (JSON.parse(value) as [string, string]) : ["", ""];
            update((p) => {
              p.alm.scope.domain = domain;
              p.alm.scope.project = project;
              p.alm.scope.folderIds = [];
              p.alm.scope.testIds = [];
            });
            onChange();
          }}
        />
        {folders.error && <Alert color="red">{errorText(folders.error)}</Alert>}
        <MultiSelect
          label="Test Plan folders (optional)"
          description="Only the tests of these folders and of the folders inside them. Leave empty for the whole Test Plan."
          placeholder={folders.isLoading ? "Loading…" : scope.folderIds.length ? undefined : "All folders"}
          searchable
          clearable
          disabled={!scope.project}
          data={(folders.data ?? []).map((folder) => ({ value: String(folder.id), label: folder.name }))}
          value={scope.folderIds.map(String)}
          onChange={(values) => {
            update((p) => void (p.alm.scope.folderIds = values.map(Number)));
            onChange();
          }}
        />
        <TagsInput
          label="Only these tests (optional)"
          description="Test ids as ALM shows them, e.g. 12, useful for a trial migration. Leave empty for everything."
          placeholder="Type an id and press Enter"
          value={scope.testIds.map(String)}
          onChange={(values) => {
            const ids = values.map((value) => Number(/(\d+)\s*$/.exec(value)?.[1])).filter((id) => Number.isInteger(id) && id > 0);
            update((p) => void (p.alm.scope.testIds = [...new Set(ids)]));
            onChange();
          }}
        />
      </Stack>
    </Card>
  );
}

/** Jira project of the test cases, optionally some folders, and an optional list of test cases for a trial run. */
function ZephyrScopeCard({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.zephyr.scope;
  const projects = useQuery({
    queryKey: ["projects", "zephyr", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkZephyr(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  const folders = useQuery({
    queryKey: ["folders", "zephyr", profile.id, scope.projectKey],
    queryFn: async () => {
      await flush();
      return api.zephyrFolders(profile.id);
    },
    enabled: Boolean(scope.projectKey),
  });
  useEffect(() => {
    const only = projects.data?.length === 1 ? projects.data[0]! : null;
    if (only?.key && !scope.projectKey) {
      update((p) => void (p.zephyr.scope.projectKey = only.key!));
    }
  }, [projects.data, scope.projectKey, update]);

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>From Zephyr</Title>
        {projects.error && <Alert color="red">{errorText(projects.error)}</Alert>}
        <Select
          label="Jira project"
          description="Projects Zephyr is turned on for."
          placeholder={projects.isLoading ? "Loading…" : "Choose a project"}
          rightSection={projects.isLoading ? <Loader size={14} /> : undefined}
          searchable
          data={[
            ...(projects.data ?? []).filter((p) => p.key).map((p) => ({ value: p.key!, label: p.name })),
            ...(scope.projectKey && !projects.data?.some((p) => p.key === scope.projectKey) ? [{ value: scope.projectKey, label: scope.projectKey }] : []),
          ]}
          value={scope.projectKey || null}
          onChange={(value) => {
            update((p) => {
              p.zephyr.scope.projectKey = value ?? "";
              p.zephyr.scope.folderIds = [];
              p.zephyr.scope.testCaseKeys = [];
            });
            onChange();
          }}
        />
        {folders.error && <Alert color="red">{errorText(folders.error)}</Alert>}
        <MultiSelect
          label="Folders (optional)"
          description="Only the test cases of these folders and of the folders inside them. Leave empty for the whole project."
          placeholder={folders.isLoading ? "Loading…" : scope.folderIds.length ? undefined : "All folders"}
          searchable
          clearable
          disabled={!scope.projectKey}
          data={(folders.data ?? []).map((folder) => ({ value: String(folder.id), label: folder.name }))}
          value={scope.folderIds.map(String)}
          onChange={(values) => {
            update((p) => void (p.zephyr.scope.folderIds = values.map(Number)));
            onChange();
          }}
        />
        <TagsInput
          label="Only these test cases (optional)"
          description={`Test case keys such as ${scope.projectKey || "CALC"}-T12, useful for a trial migration. Leave empty for everything.`}
          placeholder="Type a key and press Enter"
          value={scope.testCaseKeys}
          onChange={(values) => {
            update((p) => void (p.zephyr.scope.testCaseKeys = [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))]));
            onChange();
          }}
        />
        <Checkbox
          label="Read files of steps"
          description="Zephyr lists the files of each step separately: one more request per step. Turn it off when steps have no files, to make reading faster."
          checked={scope.stepFiles}
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            update((p) => void (p.zephyr.scope.stepFiles = checked));
            onChange();
          }}
        />
      </Stack>
    </Card>
  );
}

/** Jira project and issue type of the tests, an optional JQL filter and an optional list of tests for a trial run. */
function SquadScopeCard({ onChange }: { onChange: () => void }) {
  const { profile, update, flush } = useProfile();
  const scope = profile.squad.scope;
  const projects = useQuery({
    queryKey: ["projects", "squad", profile.id],
    queryFn: async () => {
      await flush();
      const result = await api.checkSquad(profile.id);
      if (!result.ok) {
        throw new Error(result.message);
      }
      return result.projects;
    },
  });
  useEffect(() => {
    const only = projects.data?.length === 1 ? projects.data[0]! : null;
    if (only?.key && !scope.projectKey) {
      update((p) => void (p.squad.scope.projectKey = only.key!));
    }
  }, [projects.data, scope.projectKey, update]);
  const [jql, setJql] = useState(scope.jql);
  const [issueType, setIssueType] = useState(scope.issueType);

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>From Zephyr Squad</Title>
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
            update((p) => void (p.squad.scope.projectKey = value ?? ""));
            onChange();
          }}
        />
        <TextInput
          label="Issue type of the tests"
          description="Zephyr Squad uses the issue type Test unless your Jira administrator changed it."
          value={issueType}
          onChange={(e) => setIssueType(e.currentTarget.value)}
          onBlur={() => {
            if (issueType.trim() !== scope.issueType) {
              update((p) => void (p.squad.scope.issueType = issueType.trim() || "Test"));
              onChange();
            }
          }}
        />
        <TextInput
          label="JQL filter (optional)"
          description={
            <>
              Narrows the tests of the project, e.g. <Code>labels = regression</Code> or <Code>component = Checkout</Code>. Leave empty for all tests.
            </>
          }
          placeholder="labels = regression"
          value={jql}
          onChange={(e) => setJql(e.currentTarget.value)}
          onBlur={() => {
            if (jql !== scope.jql) {
              update((p) => void (p.squad.scope.jql = jql.trim()));
              onChange();
            }
          }}
        />
        <TagsInput
          label="Only these tests (optional)"
          description="Issue keys like CALC-12, useful for a trial migration. Leave empty for everything."
          placeholder="Type a key and press Enter"
          value={scope.issueKeys}
          onChange={(values) => update((p) => void (p.squad.scope.issueKeys = [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))]))}
        />
        <Checkbox
          label="Read files of steps"
          description="When Zephyr Squad does not name the files in the list of steps, they are looked up step by step: one more request per step."
          checked={scope.stepFiles}
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            update((p) => void (p.squad.scope.stepFiles = checked));
            onChange();
          }}
        />
      </Stack>
    </Card>
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
