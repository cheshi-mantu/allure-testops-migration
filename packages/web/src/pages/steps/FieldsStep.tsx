import {
  Alert,
  Autocomplete,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  Grid,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  allowedTargets,
  mergeSuggestedMappings,
  type FieldMapping,
  type FieldTarget,
  type FieldTargetKind,
  type CsvStepFormat,
  type TestOpsDiscovery,
  type TestRailFieldInfo,
} from "@atm/shared";
import { api } from "../../api/client";
import { CustomFieldInput, DiscoveryGate, RefreshButton } from "../../components/Discovery";
import { useProfile } from "../../components/ProfileContext";

const TARGET_LABELS: Record<FieldTargetKind, string> = {
  ignore: "Do not migrate",
  customField: "Custom field",
  tag: "Tags",
  layer: "Test layer",
  status: "Status",
  owner: "Owner",
  link: "Links",
  issue: "Issues",
  description: "Description",
  precondition: "Precondition",
  expectedResult: "Expected result",
  comment: "Comment",
  scenario: "Scenario (steps)",
  scenarioExpected: "Expected results of steps",
  name: "Test case name",
  sourceId: "Case id (for reruns)",
  allureId: "Allure TestOps id (update existing case)",
  role: "Member with a role",
};

const KIND_LABELS: Record<string, string> = {
  string: "text line",
  integer: "number",
  text: "text",
  url: "URL",
  checkbox: "checkbox",
  dropdown: "dropdown",
  user: "user",
  date: "date",
  milestone: "milestone",
  steps: "steps",
  multiselect: "multi-select",
  column: "column",
  unknown: "unknown",
};

/** Targets whose values can be translated one by one. */
const VALUE_TARGETS: FieldTargetKind[] = ["customField", "tag", "layer", "status", "owner", "role", "description", "precondition", "comment"];
/** Targets that may split a free text value into several values. */
const SPLIT_TARGETS: FieldTargetKind[] = ["customField", "tag", "link", "issue", "role"];

const STEP_FORMATS: { value: CsvStepFormat; label: string }[] = [
  { value: "auto", label: "Detect automatically" },
  { value: "lines", label: "Every line is a step" },
  { value: "numbered", label: "Numbered: 1. 2. 3." },
  { value: "indented", label: "Indented: tabs or spaces make sub-steps" },
  { value: "testops", label: "Allure TestOps export: [step 1] ..." },
  { value: "regex", label: "Split by a pattern" },
  { value: "single", label: "The whole cell is one step" },
];

function defaultTarget(kind: FieldTargetKind, field: TestRailFieldInfo, testops: TestOpsDiscovery | undefined): FieldTarget {
  switch (kind) {
    case "customField":
      return { kind, name: field.label };
    case "issue":
      return { kind, integrationId: testops?.integrations.length === 1 ? testops.integrations[0]!.id : null };
    case "description":
    case "precondition":
    case "expectedResult":
      return { kind, heading: "" };
    case "role":
      return { kind, role: "" };
    default:
      return { kind } as FieldTarget;
  }
}

/** Matches TestRail users to Allure TestOps accounts by email or name. */
function suggestOwner(label: string, email: string | undefined, testops: TestOpsDiscovery | undefined): string | null {
  const users = testops?.users ?? [];
  const lower = (s?: string) => s?.trim().toLowerCase();
  return (
    users.find((u) => email && lower(u.email) === lower(email))?.username ??
    // CSV files usually hold user names or emails directly.
    users.find((u) => lower(u.username) === lower(label) || lower(u.email) === lower(label))?.username ??
    users.find((u) => lower(u.name) === lower(label))?.username ??
    users.find((u) => email && lower(u.username) === lower(email.split("@")[0]))?.username ??
    null
  );
}

/** Explicit owner values for TestRail users that match an Allure TestOps account. */
function ownerValues(field: TestRailFieldInfo, testops: TestOpsDiscovery | undefined, current: FieldMapping["values"]): FieldMapping["values"] {
  const values = { ...current };
  for (const option of field.options ?? []) {
    if (!Object.hasOwn(values, option.id)) {
      const username = suggestOwner(option.label, option.email, testops);
      if (username) {
        values[option.id] = username;
      }
    }
  }
  return values;
}

export function FieldsStep() {
  return (
    <DiscoveryGate>
      <FieldsEditor />
    </DiscoveryGate>
  );
}

type Filter = "all" | "migrated" | "skipped";

function FieldsEditor() {
  const { profile, update, source: testrail, testops } = useProfile();
  const discovery = testrail.data!;
  const [filter, setFilter] = useState<Filter>("all");

  // New fields get a suggested mapping; the user's choices stay untouched.
  useEffect(() => {
    const merged = mergeSuggestedMappings(profile.fields, discovery.fields, testops.data);
    if (merged.length !== profile.fields.length) {
      const known = new Set(profile.fields.map((m) => m.source));
      const fields = new Map(discovery.fields.map((f) => [f.systemName, f]));
      update(
        (p) =>
          void (p.fields = merged.map((m) =>
            !known.has(m.source) && (m.target.kind === "owner" || m.target.kind === "role") && fields.get(m.source)?.options
              ? { ...m, values: ownerValues(fields.get(m.source)!, testops.data, m.values) }
              : m,
          )),
      );
    }
  }, [discovery.fields, profile.fields, testops.data, update]);

  const bySource = useMemo(() => new Map(profile.fields.map((m) => [m.source, m])), [profile.fields]);
  const setMapping = (source: string, change: (mapping: FieldMapping) => void) =>
    update((p) => {
      const mapping = p.fields.find((m) => m.source === source);
      if (mapping) {
        change(mapping);
      }
    });

  const visible = discovery.fields.filter((field) => {
    const mapping = bySource.get(field.systemName);
    if (!mapping) {
      return false;
    }
    return filter === "all" || (filter === "skipped") === (mapping.target.kind === "ignore");
  });
  const csv = profile.source === "csv";
  const nameColumns = profile.fields.filter((m) => m.target.kind === "name").map((m) => m.source);
  const groups: { title: string; hint: string; fields: TestRailFieldInfo[] }[] = csv
    ? [{ title: "Columns", hint: "In file order. Values with a short list of options can be renamed or skipped one by one.", fields: visible }]
    : [
    {
      title: "Text and steps",
      hint: "Long text becomes description, precondition or expected result; steps become the scenario.",
      fields: visible.filter((f) => ["text", "steps", "url"].includes(f.kind)),
    },
    {
      title: "Fields with a list of values",
      hint: "Each value can be renamed or skipped. Values not listed in the mapping keep their TestRail name.",
      fields: visible.filter((f) => f.options !== null && !["text", "steps", "url"].includes(f.kind)),
    },
    {
      title: "Other fields",
      hint: "Short free text and numbers.",
      fields: visible.filter((f) => f.options === null && !["text", "steps", "url"].includes(f.kind)),
    },
      ];
  const skipped = profile.fields.filter((m) => m.target.kind === "ignore").length;

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" maw={720}>
          {csv
            ? `Choose where each column goes. Examples and counts come from all ${discovery.sampledCases} case(s) of the file.`
            : `Choose where each TestRail field goes. Examples and counts come from ${discovery.sampledCases} sampled case(s) of the selected suites.`}
        </Text>
        <RefreshButton />
      </Group>
      {csv && nameColumns.length !== 1 && (
        <Alert color="red">
          {nameColumns.length === 0
            ? "Map one column to the test case name."
            : `Only one column can be the test case name; now: ${nameColumns.join(", ")}.`}
        </Alert>
      )}
      {csv && !profile.fields.some((m) => m.target.kind === "sourceId") && (
        <Alert color="yellow">
          No column is the case id. Reruns then recognise cases by name, so a case renamed in the file becomes a new case. Map a column with
          stable ids to "Case id" if the file has one.
        </Alert>
      )}
      <SegmentedControl
        w={420}
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        data={[
          { value: "all", label: `All (${profile.fields.length})` },
          { value: "migrated", label: `Migrated (${profile.fields.length - skipped})` },
          { value: "skipped", label: `Not migrated (${skipped})` },
        ]}
      />
      {groups
        .filter((g) => g.fields.length > 0)
        .map((group) => (
          <Stack key={group.title} gap="xs">
            <div>
              <Title order={4}>{group.title}</Title>
              <Text size="sm" c="dimmed">
                {group.hint}
              </Text>
            </div>
            {group.fields.map((field) => (
              <FieldRow
                key={field.systemName}
                field={field}
                mapping={bySource.get(field.systemName)!}
                sampled={discovery.sampledCases}
                onChange={(change) => setMapping(field.systemName, change)}
              />
            ))}
          </Stack>
        ))}
    </Stack>
  );
}

function FieldRow({
  field,
  mapping,
  sampled,
  onChange,
}: {
  field: TestRailFieldInfo;
  mapping: FieldMapping;
  sampled: number;
  onChange: (change: (mapping: FieldMapping) => void) => void;
}) {
  const { profile, testops } = useProfile();
  const [open, setOpen] = useState(false);
  const target = mapping.target;
  const showValues = field.options !== null && VALUE_TARGETS.includes(target.kind);
  const renamed = Object.keys(mapping.values).length;

  return (
    <Card withBorder padding="sm" className="field-row">
      <Grid align="flex-start">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Group gap={6}>
            <Text fw={600}>{field.label}</Text>
            <Badge size="xs" variant="light" color="gray">
              {KIND_LABELS[field.kind]}
            </Badge>
            {field.kind === "column" && profile.csv.pathColumn === field.systemName && (
              <Tooltip label="Its levels are mapped on the Sections step">
                <Badge size="xs" variant="light" color="grape">
                  section path
                </Badge>
              </Tooltip>
            )}
            {!field.system && field.kind !== "column" && (
              <Tooltip label="Custom field in TestRail">
                <Badge size="xs" variant="dot" color="gray">
                  custom
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text size="xs" c="dimmed" className="mono">
            {field.systemName}
          </Text>
          <Text size="xs" c={field.filledCount ? "dimmed" : "orange"} mt={4}>
            {field.kind === "column"
              ? field.filledCount
                ? `Filled in ${field.filledCount} row(s)`
                : "Empty in every row"
              : field.filledCount
                ? `Filled in ${field.filledCount} of ${sampled} sampled cases`
                : "Empty in all sampled cases"}
          </Text>
          {field.examples.length > 0 && (
            <Stack gap={2} mt={6}>
              {field.examples.map((example) => (
                <Text key={example} size="xs" lineClamp={2} className="mono">
                  “{example}”
                </Text>
              ))}
            </Stack>
          )}
          {field.options && field.options.length > 0 && !showValues && (
            <Text size="xs" c="dimmed" mt={6} lineClamp={2}>
              Values: {field.options.map((o) => o.label).join(", ")}
            </Text>
          )}
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="xs">
            <Select
              aria-label={`Target for ${field.label}`}
              searchable
              data={allowedTargets(field).map((kind) => ({ value: kind, label: TARGET_LABELS[kind] }))}
              value={target.kind}
              allowDeselect={false}
              onChange={(kind) =>
                kind &&
                onChange((m) => {
                  m.target = defaultTarget(kind as FieldTargetKind, field, testops.data);
                  if ((kind === "owner" || kind === "role") && field.options) {
                    m.values = ownerValues(field, testops.data, m.values);
                  }
                })
              }
            />
            {target.kind === "customField" && (
              <CustomFieldInput
                value={target.name}
                placeholder="Custom field name"
                onChange={(name) => onChange((m) => void (m.target = { kind: "customField", name: name ?? field.label }))}
              />
            )}
            {(target.kind === "description" || target.kind === "precondition" || target.kind === "expectedResult") && (
              <TextInput
                placeholder="No heading"
                description="Heading above the text, useful when several fields share this target."
                value={target.heading}
                onChange={(e) => {
                  const heading = e.currentTarget.value;
                  onChange((m) => void (m.target = { kind: target.kind, heading }));
                }}
              />
            )}
            {target.kind === "issue" && (
              <Select
                placeholder={testops.data?.integrations.length ? "Issue tracker integration" : "The project has no issue tracker integration"}
                data={(testops.data?.integrations ?? []).map((i) => ({ value: String(i.id), label: i.name }))}
                value={target.integrationId ? String(target.integrationId) : null}
                error={target.integrationId ? undefined : "Issues are only linked when an integration is chosen"}
                onChange={(value) => onChange((m) => void (m.target = { kind: "issue", integrationId: value ? Number(value) : null }))}
              />
            )}
            {target.kind === "role" && (
              <Select
                placeholder="Allure TestOps role"
                data={[...new Set([...(testops.data?.roles ?? []).map((r) => r.name), ...(target.role ? [target.role] : [])])]}
                value={target.role || null}
                error={target.role ? (testops.data?.roles.some((r) => r.name === target.role) ? undefined : "This role does not exist in Allure TestOps") : "Choose a role"}
                onChange={(value) => onChange((m) => void (m.target = { kind: "role", role: value ?? "" }))}
              />
            )}
            {target.kind === "scenario" && field.kind === "column" && <StepFormatSettings />}
            {target.kind === "allureId" && (
              <Text size="xs" c="dimmed">
                Only for files exported from this Allure TestOps project: the case with this id is updated. Leave the column unmapped when
                importing into another project.
              </Text>
            )}
            {target.kind === "status" && (
              <Text size="xs" c="dimmed">
                Statuses must exist in the project workflow; unknown ones keep the default status.
              </Text>
            )}
            {(field.options === null || field.kind === "column") && SPLIT_TARGETS.includes(target.kind) && (
              <TextInput
                label="Split values by"
                description="E.g. a comma for “ABC-1, ABC-2”. Leave empty to keep one value."
                w={260}
                value={mapping.separator}
                onChange={(e) => {
                  const separator = e.currentTarget.value;
                  onChange((m) => void (m.separator = separator));
                }}
              />
            )}
            {showValues && (
              <Button
                variant="subtle"
                size="compact-sm"
                leftSection={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                onClick={() => setOpen((v) => !v)}
                w="fit-content"
              >
                {open ? "Hide" : "Edit"} values ({field.options!.length}
                {renamed ? `, ${renamed} changed` : ""})
              </Button>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
      {showValues && (
        <Collapse expanded={open}>
          <ValueTable field={field} mapping={mapping} onChange={onChange} />
        </Collapse>
      )}
    </Card>
  );
}

function StepFormatSettings() {
  const { profile, update, source } = useProfile();
  const steps = profile.csv.steps;
  const detected = source.data?.csv?.stepFormat;
  const set = (change: (s: typeof steps) => void) =>
    update((p) => {
      change(p.csv.steps);
    });
  return (
    <Stack gap="xs">
      <Select
        label="Steps are written as"
        allowDeselect={false}
        data={STEP_FORMATS}
        value={steps.format}
        description={steps.format === "auto" && detected ? `Detected: ${STEP_FORMATS.find((f) => f.value === detected)?.label ?? detected}` : undefined}
        onChange={(value) => value && set((s) => void (s.format = value as CsvStepFormat))}
      />
      {steps.format === "regex" && (
        <TextInput
          label="Step pattern"
          description="Regular expression; every match starts a new step and is removed from its text. (?i) makes it case insensitive."
          placeholder="(?i)step\s*\d+[:.]"
          value={steps.stepPattern}
          onChange={(e) => {
            const value = e.currentTarget.value;
            set((s) => void (s.stepPattern = value));
          }}
          error={patternError(steps.stepPattern)}
        />
      )}
      <TextInput
        label="Expected result marker (optional)"
        description='Lines or sub-steps starting with it become the expected result of their step, e.g. (?i)expected( result)?:'
        value={steps.expectedPattern}
        onChange={(e) => {
          const value = e.currentTarget.value;
          set((s) => void (s.expectedPattern = value));
        }}
        error={patternError(steps.expectedPattern)}
      />
    </Stack>
  );
}

function patternError(pattern: string): string | undefined {
  if (!pattern) {
    return undefined;
  }
  try {
    new RegExp(pattern.replace(/^\(\?[imsu]+\)/, ""));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid pattern";
  }
}

function ValueTable({
  field,
  mapping,
  onChange,
}: {
  field: TestRailFieldInfo;
  mapping: FieldMapping;
  onChange: (change: (mapping: FieldMapping) => void) => void;
}) {
  const { profile, testops } = useProfile();
  const target = mapping.target;
  const cfName = target.kind === "customField" ? target.name : null;
  const cfValues = useQuery({
    queryKey: ["cf-values", profile.id, cfName],
    queryFn: () => api.customFieldValues(profile.id, cfName!),
    enabled: Boolean(cfName),
  });
  const choices: string[] =
    target.kind === "customField"
      ? (cfValues.data ?? [])
      : target.kind === "layer"
        ? (testops.data?.layers ?? []).map((l) => l.name)
        : target.kind === "status"
          ? (testops.data?.statuses ?? []).map((s) => s.name)
          : target.kind === "owner" || target.kind === "role"
            ? (testops.data?.users ?? []).map((u) => u.username)
            : [];

  // Placeholders show exactly what the migration uses when a value is left empty.
  const suggestion = (label: string, email?: string) => {
    if (target.kind === "owner" || target.kind === "role") {
      return email ?? label;
    }
    if (target.kind === "layer" || target.kind === "status") {
      return choices.find((c) => c.toLowerCase() === label.toLowerCase()) ?? label;
    }
    return label;
  };

  const usernames = new Set((testops.data?.users ?? []).map((u) => u.username));
  const unknownOwner = (effective: string) =>
    (target.kind === "owner" || target.kind === "role") && testops.data?.users != null && !usernames.has(effective);

  const options = [...(field.options ?? [])].sort((a, b) => b.count - a.count);
  return (
    <Table mt="sm" verticalSpacing={4}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>TestRail value</Table.Th>
          <Table.Th w={90}>In sample</Table.Th>
          <Table.Th w="45%">Allure TestOps value</Table.Th>
          <Table.Th w={90}>Skip</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {options.map((option) => {
          const has = Object.hasOwn(mapping.values, option.id);
          const value = has ? mapping.values[option.id] : undefined;
          const skipped = has && value === null;
          const placeholder = suggestion(option.label, option.email);
          return (
            <Table.Tr key={option.id}>
              <Table.Td>
                <Text size="sm">{option.label}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm" c={option.count ? undefined : "dimmed"}>
                  {option.count}
                </Text>
              </Table.Td>
              <Table.Td>
                <Autocomplete
                  size="xs"
                  disabled={skipped}
                  error={!skipped && unknownOwner(typeof value === "string" ? value : placeholder) ? "No Allure TestOps user with this name" : undefined}
                  data={choices}
                  placeholder={placeholder}
                  value={typeof value === "string" ? value : ""}
                  limit={50}
                  onChange={(next) =>
                    onChange((m) => {
                      if (next.trim() === "") {
                        delete m.values[option.id];
                      } else {
                        m.values[option.id] = next;
                      }
                    })
                  }
                />
              </Table.Td>
              <Table.Td>
                <Checkbox
                  aria-label={`Skip ${option.label}`}
                  checked={skipped}
                  onChange={(e) => {
                    const skip = e.currentTarget.checked;
                    onChange((m) => {
                      if (skip) {
                        m.values[option.id] = null;
                      } else {
                        delete m.values[option.id];
                      }
                    });
                  }}
                />
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
