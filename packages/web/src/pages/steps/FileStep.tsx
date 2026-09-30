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
import { CSV_ENCODINGS, type CsvSource } from "@atm/shared";
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

function tagPrefixFor(fileName: string): string {
  const stem = fileName
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return stem ? `csv-${stem}` : "csv";
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeDelimiter(value: string): string {
  return value === "\t" ? "tab" : `"${value}"`;
}

export function FileStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const csv = profile.csv;

  const files = useQuery({ queryKey: ["files"], queryFn: api.files });
  const preview = useQuery({
    queryKey: ["csv-preview", profile.id, csv.fileId, csv.delimiter, csv.quote, csv.encoding, csv.rows, JSON.stringify(profile.fields.filter((m) => ["name", "sourceId"].includes(m.target.kind)))],
    queryFn: async () => {
      await flush();
      return api.csvPreview(profile.id);
    },
    enabled: Boolean(csv.fileId),
  });

  const forgetDiscovery = () => queryClient.removeQueries({ queryKey: ["discovery", "source", profile.id] });
  const set = <K extends keyof CsvSource>(key: K, value: CsvSource[K]) => {
    update((p) => void (p.csv[key] = value));
    forgetDiscovery();
  };
  // Ids like 1, 2, 3 repeat between files: a tag prefix per file keeps two imports into one project apart.
  // A prefix made from the previous file follows the new file; one the user typed stays.
  const followFile = (p: typeof profile, fileName: string) => {
    const previous = files.data?.find((f) => f.id === p.csv.fileId);
    const prefix = p.options.migrationTagPrefix;
    if (prefix === "csv" || (previous && prefix === tagPrefixFor(previous.name))) {
      p.options.migrationTagPrefix = tagPrefixFor(fileName);
    }
  };
  const choose = (fileId: string) => {
    const file = files.data?.find((f) => f.id === fileId);
    update((p) => {
      if (file) {
        followFile(p, file.name);
      }
      p.csv.fileId = fileId;
    });
    forgetDiscovery();
    // "Used by" is computed from saved profiles.
    void flush().then(() => queryClient.invalidateQueries({ queryKey: ["files"] }));
  };

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadFile(file),
    onSuccess: (file) => {
      queryClient.setQueryData(["files"], (list: typeof files.data) => [{ ...file, usedBy: [] }, ...(list ?? [])]);
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      update((p) => {
        followFile(p, file.name);
        p.csv.fileId = file.id;
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

  const chosenMissing = csv.fileId && files.data && !files.data.some((f) => f.id === csv.fileId);

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
            <FileButton onChange={(file) => file && upload.mutate(file)} accept=".csv,.tsv,.txt,text/csv,text/plain">
              {(props) => (
                <Button {...props} leftSection={<IconUpload size={16} />} loading={upload.isPending}>
                  Upload CSV
                </Button>
              )}
            </FileButton>
          </Group>
          {chosenMissing && (
            <Alert color="orange">The file chosen for this profile is not in the library any more, for example after importing the profile on another machine. Upload it again.</Alert>
          )}
          {files.isLoading && <Loader size="sm" />}
          {files.data?.length === 0 && <Text c="dimmed">No files yet. Upload a CSV export to start.</Text>}
          {(files.data?.length ?? 0) > 0 && (
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
                {files.data!.map((file) => {
                  const chosen = file.id === csv.fileId;
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

      {csv.fileId && !chosenMissing && (
        <>
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
        </>
      )}
    </Stack>
  );
}
