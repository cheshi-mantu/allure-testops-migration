import { Alert, Anchor, Autocomplete, Badge, Button, Card, Group, List, Stack, Table, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconPaperclip, IconStack2 } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import type { FieldTargetKind, PlannedAttachment, PlannedCase, PlannedNote, PlannedStep, Profile, TestOpsDiscovery } from "@atm/shared";
import { api, errorText } from "../../api/client";
import { DiscoveryGate } from "../../components/Discovery";
import { ErrorAlert, NoteList } from "../../components/Problems";
import { useProfile } from "../../components/ProfileContext";

export function PreviewStep() {
  return (
    <DiscoveryGate needTestOps={false}>
      <Preview />
    </DiscoveryGate>
  );
}

/**
 * What the conversion cannot know on its own: values that do not exist in Allure TestOps.
 * The same checks as in the dry run, so a single case shows them before any run.
 */
function targetNotes(planned: PlannedCase, profile: Profile, testops: TestOpsDiscovery | undefined): PlannedNote[] {
  if (!testops) {
    return [];
  }
  const fieldOf = (kind: FieldTargetKind, role?: string) =>
    profile.fields.find((m) => m.target.kind === kind && (role === undefined || (m.target.kind === "role" && m.target.role === role)))?.source;
  const same = (a: string, b: string) => a.toLowerCase() === b.trim().toLowerCase();
  const notes: PlannedNote[] = [];
  if (planned.status && !testops.statuses.some((s) => same(s.name, planned.status!))) {
    notes.push({
      code: "status-missing",
      text: `Status "${planned.status}" does not exist in Allure TestOps; the case would keep the default status.`,
      hint: "Statuses belong to the project's workflow and are not created by the migration. Map this value to an existing status in the value mapping of the status field, or add the status to the workflow in Allure TestOps.",
      fix: { step: "fields", field: fieldOf("status") },
    });
  }
  if (testops.users) {
    const known = new Set(testops.users.map((u) => u.username));
    const people = [
      ...(planned.owner ? [{ name: planned.owner, owner: true, role: undefined }] : []),
      ...planned.members.map((m) => ({ name: m.name, owner: false, role: m.role })),
    ];
    for (const person of people.filter((p) => !known.has(p.name))) {
      notes.push({
        code: "user-missing",
        text: `"${person.name}" is not an Allure TestOps user, so it would not be set as ${person.owner ? "owner" : "member"}.`,
        hint: "Map the source user to an existing Allure TestOps user name in the value mapping of the field, or create the user in Allure TestOps first.",
        fix: { step: "fields", field: person.owner ? fieldOf("owner") : fieldOf("role", person.role) },
      });
    }
  }
  for (const role of new Set(planned.members.map((m) => m.role))) {
    if (!testops.roles.some((r) => same(r.name, role))) {
      notes.push({
        code: "role-missing",
        text: `Role "${role}" does not exist in Allure TestOps, so members with it would not be set.`,
        hint: "Choose an existing role for the column, or create the role in Allure TestOps (Administration, Roles) first.",
        fix: { step: "fields", field: fieldOf("role", role) },
      });
    }
  }
  return notes;
}

function Attachments({ list }: { list: PlannedAttachment[] }) {
  if (list.length === 0) {
    return null;
  }
  return (
    <Group gap={4}>
      {list.map((a) => (
        <Badge key={`${a.sourceId}-${a.fileName}`} size="xs" variant="light" color="gray" leftSection={<IconPaperclip size={10} />} tt="none">
          {a.sourceId === null ? a.fileName : `TestRail attachment ${a.sourceId}`}
        </Badge>
      ))}
    </Group>
  );
}

function Scenario({ steps }: { steps: PlannedStep[] }) {
  if (steps.length === 0) {
    return <Text c="dimmed">No steps</Text>;
  }
  return (
    <List type="ordered" spacing="sm">
      {steps.map((step, index) =>
        step.type === "shared" ? (
          <List.Item key={index} icon={<IconStack2 size={16} />}>
            <Text size="sm">
              Shared step: <b>{step.name || `#${step.sourceId}`}</b>
            </Text>
          </List.Item>
        ) : (
          <List.Item key={index}>
            <Stack gap={4}>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {step.body}
              </Text>
              <Attachments list={step.attachments} />
              {(step.data || step.dataAttachments.length > 0) && (
                <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
                  Data: {step.data ?? ""}
                </Text>
              )}
              <Attachments list={step.dataAttachments} />
              {step.expected && (
                <Text size="sm" c="teal" style={{ whiteSpace: "pre-wrap" }}>
                  Expected: {step.expected}
                </Text>
              )}
              <Attachments list={step.expectedAttachments} />
              {step.steps && step.steps.length > 0 && <Scenario steps={step.steps} />}
            </Stack>
          </List.Item>
        ),
      )}
    </List>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Table.Tr>
      <Table.Td w={180} valign="top">
        <Text size="sm" c="dimmed">
          {label}
        </Text>
      </Table.Td>
      <Table.Td>{children}</Table.Td>
    </Table.Tr>
  );
}

function TextBlock({ value }: { value: string }) {
  return value ? <pre className="markdown-preview">{value}</pre> : <Text c="dimmed" size="sm">none</Text>;
}

function Preview() {
  const { profile, source: testrail, testops, flush } = useProfile();
  const samples = testrail.data?.sampleCaseIds ?? [];
  const csv = profile.source === "csv";
  const labelOf = (s: { id: string; name: string }) => (csv ? `${s.name} [${s.id}]` : `C${s.id}: ${s.name}`);
  const labels = new Map(samples.map((s) => [labelOf(s), s.id]));
  const [query, setQuery] = useState(samples[0] ? labelOf(samples[0]) : "");
  // A picked sample, a typed TestRail id (C123) or, for CSV, a typed case id or name.
  const caseId = labels.get(query) ?? (csv ? query.trim() || null : (/^\s*C?(\d+)/i.exec(query)?.[1] ?? null));
  const preview = useMutation({
    mutationFn: async (id: string) => {
      await flush();
      return api.preview(profile.id, id);
    },
  });
  // Statuses, users and roles of Allure TestOps, to check the converted values; the preview works without them.
  const projectChosen = Boolean(profile.testops.scope.projectId);
  useEffect(() => {
    if (projectChosen && !testops.data && !testops.isFetching && !testops.error) {
      void testops.refetch();
    }
  }, [projectChosen, testops]);
  const planned = preview.data;
  const notes = planned ? [...planned.notes, ...targetNotes(planned, profile, testops.data)] : [];

  return (
    <Stack>
      <Text c="dimmed">
        Converts one {csv ? "case of the file" : "TestRail case"} with the current settings and shows what will be written. Nothing is
        changed in Allure TestOps.
      </Text>
      <Group align="flex-end">
        <Autocomplete
          label={csv ? "Case" : "TestRail case"}
          description={csv ? "Pick a case or type its id or name." : "Pick from the sample or type a case id, e.g. C1234."}
          w={460}
          data={[...labels.keys()]}
          value={query}
          onChange={setQuery}
          limit={50}
        />
        <Button disabled={!caseId} loading={preview.isPending} onClick={() => caseId && preview.mutate(caseId)}>
          Preview
        </Button>
      </Group>
      {preview.error && <ErrorAlert error={preview.error} />}
      {planned && (
        <Stack>
          {!testops.data && (
            <Text size="sm" c="dimmed">
              {testops.error
                ? `Status, owner and members are not checked against Allure TestOps: ${errorText(testops.error)}`
                : projectChosen
                  ? "Checking values against Allure TestOps…"
                  : "Choose the Allure TestOps project to check status, owner and members against it."}
            </Text>
          )}
          {notes.length > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Worth checking">
              <NoteList notes={notes} />
            </Alert>
          )}
          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={4}>{planned.name}</Title>
              {planned.sourceUrl && (
                <Anchor href={planned.sourceUrl} target="_blank" size="sm">
                  Open in TestRail
                </Anchor>
              )}
            </Group>
            <Table>
              <Table.Tbody>
                <Row label="Tags">
                  <Group gap={4}>
                    {planned.tags.map((tag) => (
                      <Badge key={tag} variant="light" tt="none">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Row>
                <Row label="Custom fields">
                  <Stack gap={2}>
                    {Object.entries(planned.customFields).length === 0 && <Text c="dimmed">none</Text>}
                    {Object.entries(planned.customFields).map(([name, values]) => (
                      <Text size="sm" key={name}>
                        <b>{name}:</b> {values.join(", ")}
                      </Text>
                    ))}
                  </Stack>
                </Row>
                <Row label="Layer / status / owner">
                  <Text size="sm">
                    {planned.layer ?? "none"} / {planned.status ?? "default"} / {planned.owner ?? "none"}
                  </Text>
                </Row>
                {planned.allureId && (
                  <Row label="Updates">
                    <Text size="sm">Allure TestOps test case #{planned.allureId}</Text>
                  </Row>
                )}
                {planned.members.length > 0 && (
                  <Row label="Members">
                    <Text size="sm">{planned.members.map((m) => `${m.name} (${m.role})`).join(", ")}</Text>
                  </Row>
                )}
                <Row label="Links">
                  <Stack gap={2}>
                    {planned.links.length === 0 && <Text c="dimmed">none</Text>}
                    {planned.links.map((link) => (
                      <Anchor key={link.url} href={link.url} target="_blank" size="sm">
                        {link.name}
                      </Anchor>
                    ))}
                  </Stack>
                </Row>
                <Row label="Issues">
                  <Text size="sm">{planned.issues.map((i) => i.key).join(", ") || "none"}</Text>
                </Row>
                <Row label="Description">
                  <TextBlock value={planned.description} />
                </Row>
                <Row label="Precondition">
                  <TextBlock value={planned.precondition} />
                </Row>
                <Row label="Expected result">
                  <TextBlock value={planned.expectedResult} />
                </Row>
                <Row label="Comments">
                  <Stack gap={4}>
                    {planned.comments.length === 0 && <Text c="dimmed">none</Text>}
                    {planned.comments.map((comment, i) => (
                      <TextBlock key={i} value={comment} />
                    ))}
                  </Stack>
                </Row>
                {!csv && (
                <Row label="Attachments">
                  {planned.attachments.length ? <Attachments list={planned.attachments} /> : <Text c="dimmed">Inline: none</Text>}
                  <Text size="xs" c="dimmed">
                    Other files attached to the case in TestRail are migrated too.
                  </Text>
                </Row>
                )}
                <Row label="Scenario">
                  <Scenario steps={planned.scenario} />
                </Row>
              </Table.Tbody>
            </Table>
            {planned.linkedCaseIds.length > 0 && (
              <Text size="xs" c="dimmed" mt="sm">
                Links to cases {planned.linkedCaseIds.map((id) => `C${id}`).join(", ")} will point to their migrated copies.
              </Text>
            )}
          </Card>
        </Stack>
      )}
    </Stack>
  );
}
