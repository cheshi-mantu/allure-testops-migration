import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  Loader,
  Menu,
  Modal,
  NavLink,
  Paper,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconCopy,
  IconDots,
  IconDownload,
  IconEye,
  IconFileSpreadsheet,
  IconHierarchy2,
  IconListDetails,
  IconPlayerPlay,
  IconPlugConnected,
  IconSettings,
  IconTarget,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SECRET_MASK, type Profile } from "@atm/shared";
import { api, errorText } from "../api/client";
import { ProfileProvider, useProfile, type SaveState } from "../components/ProfileContext";
import { ConnectionsStep } from "./steps/ConnectionsStep";
import { FieldsStep } from "./steps/FieldsStep";
import { FileStep } from "./steps/FileStep";
import { OptionsStep } from "./steps/OptionsStep";
import { PreviewStep } from "./steps/PreviewStep";
import { RunStep } from "./steps/RunStep";
import { ScopeStep } from "./steps/ScopeStep";
import { StructureStep } from "./steps/StructureStep";

interface StepDef {
  key: string;
  label: string;
  description: string;
  icon: ReactNode;
  done: (profile: Profile) => boolean;
  /** Why the next step cannot be opened yet, if it cannot. */
  blocked?: (profile: Profile) => string | null;
  render: () => ReactNode;
}

const hasSecret = (value: string) => value === SECRET_MASK || value.trim() !== "";

const TESTRAIL_STEPS: StepDef[] = [
  {
    key: "connections",
    label: "Connections",
    description: "TestRail and Allure TestOps access",
    icon: <IconPlugConnected size={16} />,
    done: (p) => Boolean(p.testrail.connection.endpoint && hasSecret(p.testrail.connection.apiKey) && p.testops.connection.endpoint && hasSecret(p.testops.connection.apiToken)),
    render: () => <ConnectionsStep />,
  },
  {
    key: "scope",
    label: "Projects",
    description: "What to migrate and where",
    icon: <IconTarget size={16} />,
    done: (p) => Boolean(p.testrail.scope.projectId && p.testops.scope.projectId),
    render: () => <ScopeStep />,
  },
  {
    key: "structure",
    label: "Suites & sections",
    description: "Section levels → custom fields",
    icon: <IconHierarchy2 size={16} />,
    done: (p) => p.structure.levels.some(Boolean) || Boolean(p.structure.suiteField),
    render: () => <StructureStep />,
  },
  {
    key: "fields",
    label: "Fields",
    description: "TestRail fields → Allure TestOps",
    icon: <IconListDetails size={16} />,
    done: (p) => p.fields.length > 0,
    render: () => <FieldsStep />,
  },
];

const CSV_STEPS: StepDef[] = [
  {
    key: "connections",
    label: "Connection",
    description: "Allure TestOps access",
    icon: <IconPlugConnected size={16} />,
    done: (p) => Boolean(p.testops.connection.endpoint && hasSecret(p.testops.connection.apiToken)),
    render: () => <ConnectionsStep />,
  },
  {
    key: "file",
    label: "CSV file",
    description: "Upload or reuse, reading settings",
    icon: <IconFileSpreadsheet size={16} />,
    done: (p) => Boolean(p.csv.fileId),
    render: () => <FileStep />,
  },
  {
    key: "scope",
    label: "Project",
    description: "Where to migrate",
    icon: <IconTarget size={16} />,
    done: (p) => Boolean(p.testops.scope.projectId),
    render: () => <ScopeStep />,
  },
  {
    key: "structure",
    label: "Sections",
    description: "Path column levels → custom fields",
    icon: <IconHierarchy2 size={16} />,
    done: (p) => p.csv.withoutPath || Boolean(p.csv.pathColumn && p.structure.levels.some(Boolean)),
    render: () => <StructureStep />,
  },
  {
    key: "fields",
    label: "Columns",
    description: "CSV columns → Allure TestOps",
    icon: <IconListDetails size={16} />,
    done: (p) => p.fields.some((m) => m.target.kind === "name"),
    render: () => <FieldsStep />,
  },
];

const COMMON_STEPS: StepDef[] = [
  {
    key: "options",
    label: "Options",
    description: "Tags, text, attachments",
    icon: <IconSettings size={16} />,
    done: (p) => p.options.migrationTagPrefix.trim() !== "",
    blocked: (p) => (p.options.migrationTagPrefix.trim() === "" ? "Enter the migration tag prefix first." : null),
    render: () => <OptionsStep />,
  },
  {
    key: "preview",
    label: "Preview",
    description: "See one converted case",
    icon: <IconEye size={16} />,
    done: () => false,
    render: () => <PreviewStep />,
  },
  {
    key: "run",
    label: "Run",
    description: "Dry run and migration",
    icon: <IconPlayerPlay size={16} />,
    done: () => false,
    render: () => <RunStep />,
  },
];

function stepsFor(profile: Profile): StepDef[] {
  return [...(profile.source === "csv" ? CSV_STEPS : TESTRAIL_STEPS), ...COMMON_STEPS];
}

export function ProfilePage() {
  const { id = "" } = useParams();
  const profile = useQuery({ queryKey: ["profile", id], queryFn: () => api.profile(id), staleTime: Infinity, gcTime: 0 });
  if (profile.isLoading) {
    return <Loader />;
  }
  if (profile.error || !profile.data) {
    return <Alert color="red">{profile.error ? errorText(profile.error) : "Profile not found"}</Alert>;
  }
  return (
    <ProfileProvider key={profile.data.id} initial={profile.data}>
      <ProfileEditor />
    </ProfileProvider>
  );
}

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  if (state === "error") {
    return (
      <Badge color="red" variant="light" title={error ?? undefined}>
        Not saved: {error}
      </Badge>
    );
  }
  if (state === "saved") {
    return (
      <Text size="xs" c="dimmed">
        All changes saved
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      Saving…
    </Text>
  );
}

function ProfileEditor() {
  const { step = "connections" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile, update, saveState, saveError, flush } = useProfile();
  const [exporting, setExporting] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const STEPS = stepsFor(profile);
  const current = STEPS.find((s) => s.key === step) ?? STEPS[0]!;
  const index = STEPS.indexOf(current);
  const blockedReason = current.blocked?.(profile) ?? null;

  const duplicate = useMutation({
    mutationFn: async () => {
      await flush();
      return api.duplicateProfile(profile.id);
    },
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      navigate(`/profiles/${copy.id}/${current.key}`);
    },
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProfile(profile.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["profiles"] });
      navigate("/");
    },
    onError: (error) => notifications.show({ color: "red", message: errorText(error) }),
  });

  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 3 }}>
        <Paper withBorder p="sm" pos="sticky" top={72}>
          <Stack gap={4}>
            <Group justify="space-between" wrap="nowrap" mb="xs">
              <Text size="xs" c="dimmed" component={Link} to="/" style={{ textDecoration: "none" }}>
                ← All profiles
              </Text>
              <SaveIndicator state={saveState} error={saveError} />
            </Group>
            {STEPS.map((s, i) => (
              <NavLink
                key={s.key}
                active={s.key === current.key}
                label={`${i + 1}. ${s.label}`}
                description={s.description}
                leftSection={
                  s.done(profile) ? (
                    <ThemeIcon size={22} radius="xl" color="green" variant="light">
                      <IconCheck size={14} />
                    </ThemeIcon>
                  ) : (
                    <ThemeIcon size={22} radius="xl" color="gray" variant="light">
                      {s.icon}
                    </ThemeIcon>
                  )
                }
                onClick={() => navigate(`/profiles/${profile.id}/${s.key}`)}
              />
            ))}
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 9 }}>
        <Group justify="space-between" mb="md" wrap="nowrap">
          <TextInput
            aria-label="Profile name"
            value={profile.name}
            onChange={(e) => {
              const value = e.currentTarget.value;
              update((p) => {
                p.name = value || p.name;
              });
            }}
            variant="unstyled"
            styles={{ input: { fontSize: 24, fontWeight: 700 } }}
            style={{ flex: 1 }}
          />
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="default" size="lg" aria-label="Profile actions">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconDownload size={16} />} onClick={() => setExporting(true)}>
                Export to JSON
              </Menu.Item>
              <Menu.Item leftSection={<IconCopy size={16} />} onClick={() => duplicate.mutate()}>
                Duplicate
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={() => setConfirmDelete(true)}>
                Delete
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        {current.render()}

        <Group justify="space-between" mt="xl">
          {index > 0 ? (
            <Button variant="default" onClick={() => navigate(`/profiles/${profile.id}/${STEPS[index - 1]!.key}`)}>
              ← {STEPS[index - 1]!.label}
            </Button>
          ) : (
            <span />
          )}
          {index < STEPS.length - 1 && (
            <Group gap="sm">
              {blockedReason && (
                <Text size="sm" c="red">
                  {blockedReason}
                </Text>
              )}
              <Button disabled={Boolean(blockedReason)} onClick={() => navigate(`/profiles/${profile.id}/${STEPS[index + 1]!.key}`)}>
                {STEPS[index + 1]!.label} →
              </Button>
            </Group>
          )}
        </Group>
      </Grid.Col>

      <Modal opened={exporting} onClose={() => setExporting(false)} title="Export profile">
        <Stack>
          <Text size="sm">
            The JSON file contains connections, mappings and options, so the same migration can be set up on another machine with
            Import.
          </Text>
          <Checkbox
            checked={includeSecrets}
            onChange={(e) => setIncludeSecrets(e.currentTarget.checked)}
            label="Include credentials (API key, token, session cookie)"
            description="Anyone with the file can then access both systems. Leave off to enter credentials after import."
          />
          <Group justify="flex-end">
            <Button
              leftSection={<IconDownload size={16} />}
              onClick={async () => {
                await flush();
                window.location.href = api.exportUrl(profile.id, includeSecrets);
                setExporting(false);
              }}
            >
              Download
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete profile?">
        <Text size="sm">
          The profile and its run history are deleted from this tool. Nothing changes in TestRail or Allure TestOps.
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirmDelete(false)}>
            Cancel
          </Button>
          <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </Group>
      </Modal>
    </Grid>
  );
}
