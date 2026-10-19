import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  FileButton,
  Group,
  Loader,
  Modal,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconFileImport, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SourceType } from "@atm/shared";
import { api, errorText } from "../api/client";
import { RunStatusBadge } from "../components/RunStatusBadge";

export function ProfilesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const [creating, setCreating] = useState(false);
  const [source, setSource] = useState<SourceType>("testrail");
  const [name, setName] = useState("TestRail migration");
  const [nameTouched, setNameTouched] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createProfile(name, source),
    onSuccess: (profile) => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      navigate(`/profiles/${profile.id}/connections`);
    },
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });

  const importFile = useMutation({
    mutationFn: async (file: File) => api.importProfile(JSON.parse(await file.text())),
    onSuccess: (profile) => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      notifications.show({ color: "green", message: `Imported "${profile.name}". Enter the credentials if they were not included.` });
      navigate(`/profiles/${profile.id}/connections`);
    },
    onError: (error) => notifications.show({ color: "red", title: "Import failed", message: errorText(error) }),
  });

  return (
    <Container size="lg">
      <Group justify="space-between" mb="lg">
        <div>
          <Title order={2}>Migration profiles</Title>
          <Text c="dimmed">A profile holds the connections and mappings for one migration. It is saved automatically.</Text>
        </div>
        <Group>
          <FileButton onChange={(file) => file && importFile.mutate(file)} accept="application/json,.json">
            {(props) => (
              <Button {...props} variant="default" leftSection={<IconFileImport size={16} />} loading={importFile.isPending}>
                Import
              </Button>
            )}
          </FileButton>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
            New profile
          </Button>
        </Group>
      </Group>

      {profiles.isLoading && <Loader />}
      {profiles.error && <Alert color="red">{errorText(profiles.error)}</Alert>}
      {profiles.data?.length === 0 && (
        <Card withBorder p="xl">
          <Stack align="center" gap="xs">
            <Title order={4}>No profiles yet</Title>
            <Text c="dimmed" ta="center" maw={520}>
              Create a profile to migrate from TestRail, Xray Cloud, Zephyr, Qase, ALM, a CSV or an XML file: map structure and fields using the real data, preview the result
              and run the migration. Or import a profile exported on another machine.
            </Text>
            <Button mt="sm" leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>
              New profile
            </Button>
          </Stack>
        </Card>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {profiles.data?.map((profile) => (
          <Card key={profile.id} withBorder padding="lg" style={{ cursor: "pointer" }} onClick={() => navigate(`/profiles/${profile.id}`)}>
            <Group justify="space-between" mb="xs" wrap="nowrap">
              <Text fw={600} truncate>
                {profile.name}
              </Text>
              {profile.lastRun ? <RunStatusBadge run={profile.lastRun} /> : <Badge variant="light" color="gray">Not run</Badge>}
            </Group>
            <Text size="sm" c="dimmed" truncate>
              From:{" "}
              {profile.source === "csv" || profile.source === "xml"
                ? `${profile.source === "xml" ? "XML" : "CSV"} ${profile.fileName ? `"${profile.fileName}"` : "file not chosen"}`
                : profile.source === "qase"
                  ? `Qase project ${profile.qaseProject || "not chosen"}`
                  : profile.source === "alm"
                  ? `ALM project ${profile.almProject || "not chosen"}`
                  : profile.source === "testops"
                  ? `Allure TestOps: ${profile.testopsProjects?.length ? profile.testopsProjects.join(", ") : "no projects chosen"}`
                  : profile.source === "xray"
                  ? `Xray project ${profile.xrayProject || "not chosen"}`
                  : profile.source === "zephyr"
                  ? `Zephyr project ${profile.zephyrProject || "not chosen"}`
                  : profile.source === "squad"
                  ? `Zephyr Squad project ${profile.squadProject || "not chosen"}`
                  : profile.testrailEndpoint || "not set"}
            </Text>
            <Text size="sm" c="dimmed" truncate>
              To: {profile.testopsEndpoint || "not set"}
            </Text>
            <Text size="xs" c="dimmed" mt="sm">
              Updated {new Date(profile.updatedAt).toLocaleString()}
            </Text>
          </Card>
        ))}
      </SimpleGrid>

      <Modal opened={creating} onClose={() => setCreating(false)} title="New migration profile">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <Stack>
            <Radio.Group
              label="Migrate from"
              value={source}
              onChange={(value) => {
                const next = value as SourceType;
                setSource(next);
                if (!nameTouched) {
                  setName(next === "csv" ? "CSV import" : next === "xml" ? "XML import" : next === "xray" ? "Xray migration" : next === "zephyr" ? "Zephyr migration" : next === "squad" ? "Zephyr Squad migration" : next === "qase" ? "Qase migration" : next === "alm" ? "ALM migration" : next === "testops" ? "Allure TestOps copy" : "TestRail migration");
                }
              }}
            >
              <Stack gap="xs" mt="xs">
                <Radio value="testrail" label="TestRail" description="Reads projects, suites, sections, fields, shared steps and attachments through the TestRail API." />
                <Radio
                  value="xray"
                  label="Xray Cloud"
                  description="Reads Xray tests of a Jira Cloud project: steps, Cucumber and generic definitions, folders, preconditions, test sets and plans, and every Jira field."
                />
                <Radio
                  value="zephyr"
                  label="Zephyr (Scale) or Zephyr Essential, Jira Cloud"
                  description="Reads Zephyr test cases (keys such as CALC-T12) of a Jira Cloud project: folders, steps, called test cases, plain text and BDD scripts, statuses, priorities, custom fields, linked issues and files. Not yet verified on a real Zephyr: start with a dry run, with the detailed log on."
                />
                <Radio
                  value="squad"
                  label="Zephyr Squad, old experience (Jira Cloud)"
                  description="Reads tests that are Jira issues of type Test: steps with test data, expected results and files, and every Jira field, comment, link and attachment of the issue. Not yet verified on a real Zephyr Squad: start with a dry run, with the detailed log on."
                />
                <Radio
                  value="testops"
                  label="Another Allure TestOps"
                  description="Copies chosen projects of one Allure TestOps instance into another, one to one: every test case with its fields, custom fields, steps, shared steps, files, members, issues and comments."
                />
                <Radio
                  value="qase"
                  label="Qase"
                  description="Reads a Qase project through its API: suites, classic and Gherkin steps, shared steps, parameters, system and custom fields, tags and attachments."
                />
                <Radio
                  value="alm"
                  label="OpenText ALM (Quality Center)"
                  description="Reads the Test Plan of an ALM project through its REST API: folders, design steps, called tests, parameters, system and user fields, and attachments. Not yet verified on a real ALM server: start with a dry run, with the detailed log on."
                />
                <Radio
                  value="csv"
                  label="CSV file"
                  description="Any spreadsheet export: one or several rows per test case, steps in one cell or one per row."
                />
                <Radio
                  value="xml"
                  label="XML file"
                  description="An XML export of a test management tool, e.g. TestRail or TestLink: the test case element, its fields, steps and sections are found in the file."
                />
              </Stack>
            </Radio.Group>
            <TextInput
              label="Name"
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                setNameTouched(true);
              }}
              required
            />
          </Stack>
          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create
            </Button>
          </Group>
        </form>
      </Modal>
    </Container>
  );
}
