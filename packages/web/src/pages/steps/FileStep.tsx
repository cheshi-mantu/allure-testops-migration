import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  FileButton,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  TagsInput,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconTrash, IconUpload } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { CSV_ENCODINGS, type CsvSource, type XmlSource } from "@atm/shared";
import { api, errorText } from "../../api/client";
import { ErrorAlert } from "../../components/Problems";
import { useProfile } from "../../components/ProfileContext";

const DELIMITERS = [
  { value: "auto", label: "Detect automatically" },
  { value: ",", label: "Comma  ," },
  { value: ";", label: "Semicolon  ;" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe  |" },
];

type Kind = "csv" | "xml";

const isXml = (fileName: string) => /\.xml$/i.test(fileName);

function tagPrefixFor(kind: Kind, fileName: string): string {
  const stem = fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return stem ? `${kind}-${stem}` : kind;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeDelimiter(value: string): string {
  return value === "\t" ? "tab" : `"${value}"`;
}

export function FileStep() {
  const { profile } = useProfile();
  return profile.source === "xml" ? <XmlFileStep /> : <CsvFileStep />;
}

/** The file library with upload; the children are shown once a file of the library is chosen. */
function FileLibrary({ kind, children }: { kind: Kind; children: ReactNode }) {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const chosenId = profile[kind].fileId;
  const title = kind === "xml" ? "XML" : "CSV";

  const allFiles = useQuery({ queryKey: ["files"], queryFn: api.files });
  // One library for all profiles: an XML profile lists XML files, a CSV profile the rest.
  const list = allFiles.data?.filter((f) => isXml(f.name) === (kind === "xml") || f.id === chosenId);

  const forgetDiscovery = () => queryClient.removeQueries({ queryKey: ["discovery", "source", profile.id] });
  // Ids like 1, 2, 3 repeat between files: a tag prefix per file keeps two imports into one project apart.
  // A prefix made from the previous file follows the new file; one the user typed stays.
  const followFile = (p: typeof profile, fileName: string) => {
    const previous = allFiles.data?.find((f) => f.id === p[kind].fileId);
    const prefix = p.options.migrationTagPrefix;
    if (prefix === "" || prefix === kind || (previous && prefix === tagPrefixFor(kind, previous.name))) {
      p.options.migrationTagPrefix = tagPrefixFor(kind, fileName);
    }
  };
  const choose = (fileId: string) => {
    const file = allFiles.data?.find((f) => f.id === fileId);
    update((p) => {
      if (file) {
        followFile(p, file.name);
      }
      p[kind].fileId = fileId;
      if (kind === "xml") {
        // Another file may call its test cases differently.
        p.xml.caseElement = null;
      }
    });
    forgetDiscovery();
    // "Used by" is computed from saved profiles.
    void flush().then(() => queryClient.invalidateQueries({ queryKey: ["files"] }));
  };

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFile(file),
    onSuccess: (file) => {
      queryClient.setQueryData(["files"], (current: typeof allFiles.data) => [{ ...file, usedBy: [] }, ...(current ?? [])]);
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      update((p) => {
        followFile(p, file.name);
        p[kind].fileId = file.id;
        if (kind === "xml") {
          p.xml.caseElement = null;
        }
      });
      forgetDiscovery();
      notifications.show({ color: "green", message: `Uploaded "${file.name}".` });
    },
    onError: (error) => notifications.show({ color: "red", title: "Upload failed", message: errorText(error) }),
  });
  const remove = useMutation({
    mutationFn: (fileId: string) => api.deleteFile(fileId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["files"] }),
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });

  const chosenMissing = chosenId && allFiles.data && !allFiles.data.some((f) => f.id === chosenId);

  return (
    <Stack>
      <Text c="dimmed">
        Files are kept in the tool's data volume, so other profiles can reuse them. Upload a new version as a new file to keep the old
        one for comparison.
      </Text>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={4}>File</Title>
            <FileButton onChange={(file) => file && upload.mutate(file)} accept={kind === "xml" ? ".xml,text/xml,application/xml" : ".csv,.tsv,.txt,text/csv,text/plain"}>
              {(props) => (
                <Button {...props} leftSection={<IconUpload size={16} />} loading={upload.isPending}>
                  Upload {title}
                </Button>
              )}
            </FileButton>
          </Group>
          {chosenMissing && (
            <Alert color="orange">The file chosen for this profile is not in the library any more, for example after importing the profile on another machine. Upload it again.</Alert>
          )}
          {allFiles.isLoading && <Loader size="sm" />}
          {list?.length === 0 && <Text c="dimmed">No {title} files yet. Upload {kind === "xml" ? "an XML" : "a CSV"} export to start.</Text>}
          {(list?.length ?? 0) > 0 && (
            <Table highlightOnHover verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36} />
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Uploaded</Table.Th>
                  <Table.Th>Used by</Table.Th>
                  <Table.Th w={40} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list!.map((file) => {
                  const chosen = file.id === chosenId;
                  const others = file.usedBy.filter((p) => p.id !== profile.id);
                  return (
                    <Table.Tr
                      key={file.id}
                      style={{ cursor: "pointer" }}
                      bg={chosen ? "var(--mantine-color-blue-light)" : undefined}
                      onClick={() => !chosen && choose(file.id)}
                    >
                      <Table.Td>{chosen && <IconCheck size={16} color="var(--mantine-color-blue-6)" />}</Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={chosen ? 600 : undefined}>
                          {file.name}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{size(file.size)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{new Date(file.uploadedAt).toLocaleString()}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {file.usedBy.map((p) => (
                            <Badge key={p.id} size="sm" variant="light" color={p.id === profile.id ? "blue" : "gray"} tt="none">
                              {p.id === profile.id ? "this profile" : p.name}
                            </Badge>
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Tooltip label={file.usedBy.length > 0 ? "Used by a profile" : "Delete"}>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={`Delete ${file.name}`}
                            disabled={others.length > 0 || chosen}
                            onClick={(event) => {
                              event.stopPropagation();
                              remove.mutate(file.id);
                            }}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Card>

      {chosenId && !chosenMissing && children}
    </Stack>
  );
}

function CsvFileStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const csv = profile.csv;
  const preview = useQuery({
    queryKey: ["csv-preview", profile.id, csv.fileId, csv.delimiter, csv.quote, csv.encoding, csv.rows, JSON.stringify(profile.fields.filter((m) => ["name", "sourceId"].includes(m.target.kind)))],
    queryFn: async () => {
      await flush();
      return api.csvPreview(profile.id);
    },
    enabled: Boolean(csv.fileId),
  });
  const set = <K extends keyof CsvSource>(key: K, value: CsvSource[K]) => {
    update((p) => void (p.csv[key] = value));
    queryClient.removeQueries({ queryKey: ["discovery", "source", profile.id] });
  };

  return (
    <FileLibrary kind="csv">
      <Card withBorder>
        <Stack>
          <Title order={4}>Reading</Title>
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select
              label="Delimiter"
              allowDeselect={false}
              data={DELIMITERS}
              value={csv.delimiter}
              onChange={(value) => value && set("delimiter", value)}
              description={preview.data && csv.delimiter === "auto" ? `Detected: ${describeDelimiter(preview.data.delimiter)}` : undefined}
            />
            <Select
              label="Encoding"
              allowDeselect={false}
              data={CSV_ENCODINGS.map((e) => ({ value: e, label: e === "auto" ? "Detect automatically" : e }))}
              value={csv.encoding}
              onChange={(value) => value && set("encoding", value as CsvSource["encoding"])}
              description={preview.data && csv.encoding === "auto" ? `Detected: ${preview.data.encoding}` : undefined}
            />
            <Select
              label="Quote character"
              allowDeselect={false}
              data={[
                { value: '"', label: 'Double quote  "' },
                { value: "'", label: "Single quote  '" },
              ]}
              value={csv.quote}
              onChange={(value) => value && set("quote", value)}
            />
          </SimpleGrid>
          <div>
            <Text size="sm" fw={500}>
              Rows and test cases
            </Text>
            <Text size="xs" c="dimmed" mb={6}>
              Some exports put each step on its own row: the first row carries the case, the rows after it have no name and add steps.
            </Text>
            <SegmentedControl
              value={csv.rows}
              onChange={(value) => set("rows", value as CsvSource["rows"])}
              data={[
                { value: "auto", label: "Detect" },
                { value: "single", label: "One row per case" },
                { value: "multi", label: "Cases span several rows" },
              ]}
            />
          </div>
          <TagsInput
            label="Only these cases (optional)"
            description="Ids or names for a trial migration. Leave empty for the whole file."
            placeholder="Type and press Enter"
            value={csv.onlyCases}
            onChange={(values) => set("onlyCases", values)}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={4}>First rows</Title>
            {preview.data && (
              <Group gap="xs">
                <Badge variant="light">{preview.data.rowCount} rows</Badge>
                <Badge variant="light">{preview.data.columns.length} columns</Badge>
                <Badge variant="light" color="grape">
                  {preview.data.caseCount} test cases{preview.data.multiRow ? ", several rows each" : ""}
                </Badge>
              </Group>
            )}
          </Group>
          {preview.isFetching && !preview.data && <Loader size="sm" />}
          {preview.error && <ErrorAlert error={preview.error} />}
          {preview.data?.warnings.map((warning) => (
            <Alert key={warning} color="yellow">
              {warning}
            </Alert>
          ))}
          {preview.data && (
            <ScrollArea type="auto" mah={420}>
              <Table withColumnBorders withTableBorder verticalSpacing={4} fz="xs" style={{ whiteSpace: "pre-wrap" }}>
                <Table.Thead>
                  <Table.Tr>
                    {preview.data.columns.map((column) => (
                      <Table.Th key={column} miw={120}>
                        {column}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.data.rows.map((row, index) => (
                    <Table.Tr key={index}>
                      {row.map((cell, i) => (
                        <Table.Td key={i} valign="top" maw={320}>
                          <Text size="xs" lineClamp={6} style={{ whiteSpace: "pre-wrap" }}>
                            {cell}
                          </Text>
                        </Table.Td>
                      ))}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Card>
    </FileLibrary>
  );
}

function XmlFileStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const xml = profile.xml;
  const preview = useQuery({
    queryKey: ["xml-preview", profile.id, xml.fileId, xml.caseElement, JSON.stringify(profile.fields.filter((m) => ["name", "sourceId"].includes(m.target.kind)))],
    queryFn: async () => {
      await flush();
      return api.xmlPreview(profile.id);
    },
    enabled: Boolean(xml.fileId),
  });
  const set = <K extends keyof XmlSource>(key: K, value: XmlSource[K]) => {
    update((p) => void (p.xml[key] = value));
    queryClient.removeQueries({ queryKey: ["discovery", "source", profile.id] });
  };
  const data = preview.data;
  const candidates = data?.candidates ?? [];
  const elements = [
    { value: "", label: "Detect automatically" },
    ...candidates.map((c) => ({ value: c.name, label: `<${c.name}>, ${c.count} in the file` })),
    ...(xml.caseElement && !candidates.some((c) => c.name === xml.caseElement) ? [{ value: xml.caseElement, label: `<${xml.caseElement}>` }] : []),
  ];

  return (
    <FileLibrary kind="xml">
      <Card withBorder>
        <Stack>
          <Title order={4}>Reading</Title>
          <Text size="sm" c="dimmed">
            The file is read by its structure, whatever tool exported it: the element that repeats and has a name or title is a test case,
            its child elements and attributes are fields, a list of step elements is the scenario, and the named elements around the
            cases (suites, sections, folders) are the section path.
          </Text>
          <Select
            label="Test case element"
            maw={420}
            allowDeselect={false}
            data={elements}
            value={xml.caseElement ?? ""}
            onChange={(value) => set("caseElement", value || null)}
            description={data?.caseElement && !xml.caseElement ? `Detected: <${data.caseElement}>` : "Change it when the cases below are not what you expect."}
          />
          <TagsInput
            label="Only these cases (optional)"
            description="Ids or names for a trial migration. Leave empty for the whole file."
            placeholder="Type and press Enter"
            value={xml.onlyCases}
            onChange={(values) => set("onlyCases", values)}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={4}>Found in the file</Title>
            {data && (
              <Group gap="xs">
                <Badge variant="light" color="grape">
                  {data.caseCount} test cases
                </Badge>
                <Badge variant="light">{data.fieldCount} fields</Badge>
                <Badge variant="light">{data.depth > 0 ? `sections up to ${data.depth} level(s) deep` : "no sections"}</Badge>
              </Group>
            )}
          </Group>
          {preview.isFetching && !data && <Loader size="sm" />}
          {preview.error && <ErrorAlert error={preview.error} />}
          {data?.warnings.map((warning) => (
            <Alert key={warning} color="yellow">
              {warning}
            </Alert>
          ))}
          {data?.stepLists.map((list) => (
            <Text size="sm" key={list.field}>
              Steps: <span className="mono">{list.field}</span> in {list.cases} case(s). Action from{" "}
              <span className="mono">{list.action ?? "the step itself"}</span>
              {list.expected ? (
                <>
                  , expected result from <span className="mono">{list.expected}</span>
                </>
              ) : (
                ", no expected result element"
              )}
              {list.data && (
                <>
                  , data from <span className="mono">{list.data}</span>
                </>
              )}
              .
            </Text>
          ))}
          {data && data.caseCount > 0 && data.stepLists.length === 0 && (
            <Text size="sm" c="dimmed">
              No list of step elements was found. Steps written as text in one field can be mapped to the scenario on the Fields step.
            </Text>
          )}
          {data && data.sample.length > 0 && (
            <ScrollArea type="auto">
              <Table withColumnBorders withTableBorder verticalSpacing={4} fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={70}>Line</Table.Th>
                    <Table.Th w={140}>Case id</Table.Th>
                    <Table.Th>Name</Table.Th>
                    <Table.Th>Sections</Table.Th>
                    <Table.Th w={70}>Steps</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.sample.map((row) => (
                    <Table.Tr key={row.line}>
                      <Table.Td>{row.line}</Table.Td>
                      <Table.Td className="mono">{row.id}</Table.Td>
                      <Table.Td>{row.name || <Text span size="xs" c="orange">no name</Text>}</Table.Td>
                      <Table.Td>{row.path.join(" › ")}</Table.Td>
                      <Table.Td>{row.steps || ""}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
          {data && data.caseCount > data.sample.length && (
            <Text size="xs" c="dimmed">
              The first {data.sample.length} of {data.caseCount} cases. Names and ids follow the mapping on the Fields step.
            </Text>
          )}
        </Stack>
      </Card>
    </FileLibrary>
  );
}
