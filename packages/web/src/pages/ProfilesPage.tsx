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
import { api, errorText } from "../api/client";
import { RunStatusBadge } from "../components/RunStatusBadge";

export function ProfilesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("TestRail migration");

  const create = useMutation({
    mutationFn: () => api.createProfile(name),
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
              Create a profile to connect TestRail and Allure TestOps, map suites, sections and fields, preview the result and run the
              migration. Or import a profile exported on another machine.
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
              From: {profile.testrailEndpoint || "not set"}
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
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus required />
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
