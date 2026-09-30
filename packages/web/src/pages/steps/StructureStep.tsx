import {
  Alert,
  Anchor,
  Badge,
  Card,
  Group,
  NumberInput,
  Radio,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useEffect } from "react";
import { mapSectionPath } from "@atm/shared";
import { CustomFieldInput, DiscoveryGate, RefreshButton } from "../../components/Discovery";
import { useProfile } from "../../components/ProfileContext";

const PATH_SEPARATORS = [
  { value: "auto", label: "Detect automatically" },
  { value: " > ", label: "A > B > C" },
  { value: " / ", label: "A / B / C" },
  { value: "/", label: "A/B/C" },
  { value: "\\", label: "A\\B\\C" },
  { value: " » ", label: "A » B » C" },
  { value: "::", label: "A::B::C" },
  { value: " | ", label: "A | B | C" },
];

/** CSV: which column holds the section path and how its levels are separated. */
function PathColumnCard() {
  const { profile, update, source, refreshDiscovery } = useProfile();
  const info = source.data?.csv;
  const columns = source.data?.fields.map((f) => f.systemName) ?? [];
  const candidates = info?.pathCandidates ?? [];
  const choose = (column: string | null) => {
    update((p) => {
      p.csv.pathColumn = column;
      p.csv.pathSeparator = "auto";
      // The path column feeds the levels; do not also migrate it as a plain field.
      const mapping = p.fields.find((m) => m.source === column);
      if (mapping && ["customField", "description"].includes(mapping.target.kind)) {
        mapping.target = { kind: "ignore" };
      }
    });
    void refreshDiscovery("source");
  };
  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Section path column</Title>
        <Text size="sm" c="dimmed">
          A column like <i>Web &gt; Checkout &gt; Payment</i> or <i>/Web/Checkout/Payment</i> describes where a case sits. Its levels are
          mapped below.
        </Text>
        <Group align="flex-end">
          <Select
            label="Column"
            w={320}
            placeholder="No section path"
            clearable
            data={[
              ...(candidates.length > 0 ? [{ group: "Look like paths", items: candidates.map((c) => c.column) }] : []),
              { group: "Other columns", items: columns.filter((c) => !candidates.some((x) => x.column === c)) },
            ]}
            value={profile.csv.pathColumn}
            onChange={choose}
          />
          {profile.csv.pathColumn && (
            <Select
              label="Levels separated by"
              w={240}
              allowDeselect={false}
              data={PATH_SEPARATORS}
              value={PATH_SEPARATORS.some((s) => s.value === profile.csv.pathSeparator) ? profile.csv.pathSeparator : "auto"}
              description={profile.csv.pathSeparator === "auto" && info?.pathSeparator ? `Detected: "${info.pathSeparator.trim()}"` : undefined}
              onChange={(value) => {
                if (value) {
                  update((p) => void (p.csv.pathSeparator = value));
                  void refreshDiscovery("source");
                }
              }}
            />
          )}
        </Group>
        {!profile.csv.pathColumn && candidates.length > 0 && (
          <Alert color="blue">
            "{candidates[0]!.column}" looks like a section path.{" "}
            <Anchor component="button" type="button" onClick={() => choose(candidates[0]!.column)}>
              Use it
            </Anchor>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}

export function StructureStep() {
  return (
    <DiscoveryGate>
      <StructureEditor />
    </DiscoveryGate>
  );
}

function StructureEditor() {
  const { profile, update, source: testrail } = useProfile();
  const discovery = testrail.data!;
  const structure = profile.structure;
  const csv = profile.source === "csv";
  const mappedCount = structure.levels.length;
  const multiSuite = discovery.suites.length > 1;

  // First visit: give every detected level a row to fill in.
  useEffect(() => {
    if (structure.levels.length === 0 && discovery.maxDepth > 0) {
      update((p) => void (p.structure.levels = Array.from({ length: discovery.maxDepth }, () => null)));
    }
  }, [discovery.maxDepth, structure.levels.length, update]);

  const setLevelCount = (count: number) =>
    update((p) => {
      const levels = p.structure.levels.slice(0, count);
      while (levels.length < count) {
        levels.push(null);
      }
      p.structure.levels = levels;
    });

  const deepPath = discovery.structure.flatMap((suite) => suite.examplePaths).find((path) => path.length > mappedCount);
  const joinExample = deepPath && mappedCount > 0 ? deepPath.slice(mappedCount - 1).join(structure.joinSeparator) : null;

  const treeFields = [structure.suiteField, ...structure.levels].filter((f): f is string => Boolean(f));
  const uniqueTreeFields = [...new Set(treeFields)];

  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed" maw={720}>
          Every nesting level of {csv ? "the section path" : "TestRail sections"} becomes its own custom field in Allure TestOps, so you
          can build a tree like <i>Epic → Feature → Story</i> instead of generic <i>Section1, Section2</i> fields.
        </Text>
        <RefreshButton />
      </Group>

      {csv && <PathColumnCard />}

      {(!csv || profile.csv.pathColumn) && (
      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={4}>Detected structure</Title>
            <Group gap="xs">
              {!csv && <Badge variant="light">{discovery.suites.length} suite(s)</Badge>}
              <Badge variant="light">{discovery.structure.reduce((sum, s) => sum + s.sectionCount, 0)} sections</Badge>
              <Badge variant="light" color="grape">
                up to {discovery.maxDepth} level(s) deep
              </Badge>
            </Group>
          </Group>
          {discovery.maxDepth === 0 && (
            <Alert color="blue">
              {csv ? "The path column is empty in every row." : "The selected suites have no sections; only the suite can be mapped."}
            </Alert>
          )}
          {discovery.structure.length > 1 && (
            <Table withRowBorders={false} verticalSpacing={4}>
              <Table.Tbody>
                {discovery.structure.map((suite) => (
                  <Table.Tr key={suite.suite.id}>
                    <Table.Td w="40%">
                      <Text size="sm" fw={500}>
                        {suite.suite.name}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {suite.sectionCount} sections, {suite.maxDepth} level(s)
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Card>
      )}

      {multiSuite && (
        <Card withBorder>
          <Stack gap="xs">
            <Title order={4}>Suite</Title>
            <Text size="sm" c="dimmed">
              The project has several suites. Store the suite name in a custom field to keep them apart, it becomes the top of the tree.
            </Text>
            <CustomFieldInput
              value={structure.suiteField}
              onChange={(value) => update((p) => void (p.structure.suiteField = value))}
              placeholder="Not migrated, e.g. Suite"
            />
            <Text size="xs" c="dimmed">
              Values: {discovery.suites.map((s) => s.name).join(", ")}
            </Text>
          </Stack>
        </Card>
      )}

      {discovery.maxDepth > 0 && (
        <Card withBorder>
          <Stack>
            <Group justify="space-between" align="flex-end">
              <div>
                <Title order={4}>Section levels</Title>
                <Text size="sm" c="dimmed">
                  Choose a custom field for each level. Leave a level empty to skip it.
                </Text>
              </div>
              <NumberInput
                label="Levels with their own field"
                min={1}
                max={discovery.maxDepth}
                w={200}
                value={mappedCount}
                onChange={(value) => setLevelCount(Math.max(1, Math.min(discovery.maxDepth, Number(value) || 1)))}
              />
            </Group>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={70}>Level</Table.Th>
                  <Table.Th>Sections found</Table.Th>
                  <Table.Th w="38%">Allure TestOps custom field</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {discovery.levels.map((level) => {
                  const index = level.level - 1;
                  const mapped = index < mappedCount;
                  return (
                    <Table.Tr key={level.level}>
                      <Table.Td>
                        <Badge variant="light" color={mapped ? "blue" : "gray"}>
                          {level.level}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{level.examples.join(", ")}</Text>
                        <Text size="xs" c="dimmed">
                          {level.sectionCount} section(s){level.caseCount ? `, ${level.caseCount} sampled case(s) directly here` : ""}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {mapped ? (
                          <CustomFieldInput
                            value={structure.levels[index] ?? null}
                            onChange={(value) =>
                              update((p) => {
                                p.structure.levels[index] = value;
                              })
                            }
                          />
                        ) : (
                          <Text size="sm" c="dimmed">
                            {structure.deeperLevels === "join" && structure.levels[mappedCount - 1]
                              ? `Joined into "${structure.levels[mappedCount - 1]}"`
                              : "Not migrated"}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            {mappedCount < discovery.maxDepth && (
              <Radio.Group
                label={`Sections deeper than level ${mappedCount}`}
                value={structure.deeperLevels}
                onChange={(value) => update((p) => void (p.structure.deeperLevels = value as "join" | "drop"))}
              >
                <Stack gap="xs" mt="xs">
                  <Radio value="join" label={`Join into the level ${mappedCount} field${joinExample ? `, e.g. "${joinExample}"` : ""}`} />
                  <Radio value="drop" label="Do not migrate them" />
                </Stack>
              </Radio.Group>
            )}
            {mappedCount < discovery.maxDepth && structure.deeperLevels === "join" && (
              <TextInput
                label="Separator for joined levels"
                w={200}
                value={structure.joinSeparator}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  update((p) => void (p.structure.joinSeparator = value || " / "));
                }}
              />
            )}
          </Stack>
        </Card>
      )}

      <Card withBorder>
        <Stack>
          <Title order={4}>Tree</Title>
          <Switch
            label="Create an Allure TestOps tree from these fields"
            description={`The tree shows migrated cases grouped the same way as in ${csv ? "the file" : "TestRail"}. An existing tree with the same name is kept as is.`}
            checked={structure.createTree}
            onChange={(e) => {
              const value = e.currentTarget.checked;
              update((p) => void (p.structure.createTree = value));
            }}
          />
          {structure.createTree && (
            <>
              <TextInput
                label="Tree name"
                value={structure.treeName}
                w={320}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  update((p) => void (p.structure.treeName = value));
                }}
              />
              <Group gap={6}>
                {uniqueTreeFields.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    Choose at least one field above.
                  </Text>
                ) : (
                  uniqueTreeFields.map((field, i) => (
                    <Group gap={6} key={field}>
                      {i > 0 && <IconArrowRight size={14} />}
                      <Badge variant="outline" tt="none">
                        {field}
                      </Badge>
                    </Group>
                  ))
                )}
              </Group>
            </>
          )}
        </Stack>
      </Card>

      {discovery.structure.some((suite) => suite.examplePaths.length > 0) && (
      <Card withBorder>
        <Stack gap="xs">
          <Title order={4}>Examples</Title>
          <Text size="sm" c="dimmed">
            How the deepest sections of your project will look in Allure TestOps.
          </Text>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{csv ? "Path in the file" : "TestRail"}</Table.Th>
                <Table.Th>Allure TestOps custom fields</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {discovery.structure.flatMap((suite) =>
                suite.examplePaths.slice(0, 3).map((path) => {
                  const sections = mapSectionPath(path, structure);
                  // Same order as the tree: suite first.
                  const values = new Map<string, string[]>(structure.suiteField ? [[structure.suiteField, [suite.suite.name]]] : []);
                  for (const [field, list] of sections) {
                    values.set(field, [...(values.get(field) ?? []), ...list]);
                  }
                  return (
                    <Table.Tr key={`${suite.suite.id}-${path.join("/")}`}>
                      <Table.Td>
                        <Text size="sm">{[multiSuite ? suite.suite.name : null, ...path].filter(Boolean).join(" › ")}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6}>
                          {values.size === 0 && (
                            <Text size="sm" c="dimmed">
                              nothing
                            </Text>
                          )}
                          {[...values.entries()].map(([field, list]) => (
                            <Badge key={field} variant="light" tt="none">
                              {field}: {list.join(", ")}
                            </Badge>
                          ))}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  );
                }),
              )}
            </Table.Tbody>
          </Table>
        </Stack>
      </Card>
      )}
    </Stack>
  );
}
