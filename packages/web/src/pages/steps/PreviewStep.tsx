import { Alert, Anchor, Autocomplete, Badge, Button, Card, Group, List, Stack, Table, Text, Title } from "@mantine/core";
import { IconAlertTriangle, IconPaperclip, IconStack2 } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import type { PlannedAttachment, PlannedStep } from "@atm/shared";
import { api, errorText } from "../../api/client";
import { DiscoveryGate } from "../../components/Discovery";
import { useProfile } from "../../components/ProfileContext";

export function PreviewStep() {
  return (
    <DiscoveryGate needTestOps={false}>
      <Preview />
    </DiscoveryGate>
  );
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
  const { profile, source: testrail, flush } = useProfile();
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
  const planned = preview.data;

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
      {preview.error && <Alert color="red">{errorText(preview.error)}</Alert>}
      {planned && (
        <Stack>
          {planned.notes.length > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle size={16} />} title="Worth checking">
              {planned.notes.map((note) => (
                <Text size="sm" key={note}>
                  {note}
                </Text>
              ))}
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
