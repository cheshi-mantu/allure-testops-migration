import { Card, NumberInput, Radio, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import type { MigrationOptions } from "@atm/shared";
import { useProfile } from "../../components/ProfileContext";

export function OptionsStep() {
  const { profile, update } = useProfile();
  const options = profile.options;
  const set = <K extends keyof MigrationOptions>(key: K, value: MigrationOptions[K]) => update((p) => void (p.options[key] = value));

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <Card withBorder>
        <Stack>
          <Title order={4}>Identification</Title>
          <TextInput
            label="Migration tag prefix"
            description={`Every case gets the tag "${options.migrationTagPrefix}:<TestRail id>". Reruns find cases by this tag and update them. Keep "testrail" to continue a migration made with the previous migration tool.`}
            value={options.migrationTagPrefix}
            onChange={(e) => {
              const value = e.currentTarget.value.trim();
              set("migrationTagPrefix", value || "testrail");
            }}
          />
          <TextInput
            label="Additional tag"
            description="Optional tag added to every migrated case, e.g. “from-testrail”."
            value={options.additionalTag}
            onChange={(e) => set("additionalTag", e.currentTarget.value)}
          />
          <Switch
            label="Link back to the TestRail case"
            checked={options.selfLink}
            onChange={(e) => set("selfLink", e.currentTarget.checked)}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={4}>Text</Title>
          <Radio.Group
            label="TestRail text format"
            description="Newer TestRail versions store HTML; older ones use Markdown."
            value={options.textFormat}
            onChange={(value) => set("textFormat", value as MigrationOptions["textFormat"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="auto" label="Detect automatically (recommended)" />
              <Radio value="markdown" label="Markdown" />
              <Radio value="html" label="HTML" />
            </Stack>
          </Radio.Group>
          <Radio.Group
            label="Steps written as plain text"
            value={options.textSteps}
            onChange={(value) => set("textSteps", value as MigrationOptions["textSteps"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="lines" label="One step per line (list numbers are removed)" />
              <Radio value="single" label="Keep as a single step" />
            </Stack>
          </Radio.Group>
          <Switch
            label="Add suite and section descriptions to the case description"
            checked={options.parentDescriptions}
            onChange={(e) => set("parentDescriptions", e.currentTarget.checked)}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={4}>Content</Title>
          <Switch
            label="Migrate attachments"
            description="Case attachments and images inside text and steps."
            checked={options.migrateAttachments}
            onChange={(e) => set("migrateAttachments", e.currentTarget.checked)}
          />
          <Switch
            label="Migrate shared steps"
            description="TestRail shared steps become Allure TestOps shared steps. When off, their steps are copied into each case."
            checked={options.migrateSharedSteps}
            onChange={(e) => set("migrateSharedSteps", e.currentTarget.checked)}
          />
          <Switch
            label="Include deleted cases"
            description="Only for TestRail versions that expose deleted cases through the API."
            checked={options.includeDeleted}
            onChange={(e) => set("includeDeleted", e.currentTarget.checked)}
          />
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={4}>Performance</Title>
          <NumberInput
            label="Cases migrated in parallel"
            description="Higher is faster but puts more load on both servers. TestRail rate limits are respected automatically."
            min={1}
            max={16}
            w={260}
            value={options.concurrency}
            onChange={(value) => set("concurrency", Math.max(1, Math.min(16, Number(value) || 1)))}
          />
          <Text size="xs" c="dimmed">
            Requests failing with 429 or 5xx are retried with back-off.
          </Text>
        </Stack>
      </Card>
    </SimpleGrid>
  );
}
