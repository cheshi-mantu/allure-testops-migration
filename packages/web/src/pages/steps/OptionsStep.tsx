import { Card, NumberInput, Radio, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import type { MigrationOptions } from "@atm/shared";
import { useProfile } from "../../components/ProfileContext";

export function OptionsStep() {
  const { profile, update } = useProfile();
  const options = profile.options;
  const csv = profile.source === "csv";
  const xray = profile.source === "xray";
  const testrail = profile.source === "testrail";
  const prefixMissing = options.migrationTagPrefix.trim() === "";
  const prefixShown = prefixMissing ? "<prefix>" : options.migrationTagPrefix;
  const set = <K extends keyof MigrationOptions>(key: K, value: MigrationOptions[K]) => update((p) => void (p.options[key] = value));

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <Card withBorder>
        <Stack>
          <Title order={4}>Identification</Title>
          <TextInput
            label="Migration tag prefix"
            withAsterisk
            description={
              csv
                ? `Every case gets the tag "${prefixShown}:<case id>". Reruns find cases by this tag and update them.`
                : xray
                  ? `Every case gets the tag "${prefixShown}:<issue key>", e.g. "${prefixShown}:CALC-12". Reruns find cases by this tag and update them.`
                  : `Every case gets the tag "${prefixShown}:<TestRail id>". Reruns find cases by this tag and update them. Keep "testrail" to continue a migration made with the previous migration tool.`
            }
            placeholder={csv ? "e.g. csv-regression" : xray ? "xray" : "testrail"}
            value={options.migrationTagPrefix}
            error={prefixMissing ? "Enter a prefix. Without it migrated cases cannot be found again, so the migration cannot start." : undefined}
            onChange={(e) => set("migrationTagPrefix", e.currentTarget.value.trim())}
          />
          <TextInput
            label="Additional tag"
            description={`Optional tag added to every migrated case, e.g. “from-${xray ? "xray" : csv ? "csv" : "testrail"}”.`}
            value={options.additionalTag}
            onChange={(e) => set("additionalTag", e.currentTarget.value)}
          />
          {!csv && (
          <Switch
            label={xray ? "Link back to the Jira issue" : "Link back to the TestRail case"}
            checked={options.selfLink}
            onChange={(e) => set("selfLink", e.currentTarget.checked)}
          />
          )}
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={4}>Text</Title>
          {!xray && (
          <Radio.Group
            label={csv ? "Text format" : "TestRail text format"}
            description={csv ? "Text cells may hold Markdown or HTML." : "Newer TestRail versions store HTML; older ones use Markdown."}
            value={options.textFormat}
            onChange={(value) => set("textFormat", value as MigrationOptions["textFormat"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="auto" label="Detect automatically (recommended)" />
              <Radio value="markdown" label="Markdown" />
              <Radio value="html" label="HTML" />
            </Stack>
          </Radio.Group>
          )}
          {xray && (
            <Text size="sm" c="dimmed">
              Jira rich text and Xray wiki markup are converted to Markdown; images in Jira text become attachments of the case.
            </Text>
          )}
          {!csv && (
          <Radio.Group
            label={xray ? "Generic definitions and other text mapped to the scenario" : "Steps written as plain text"}
            value={options.textSteps}
            onChange={(value) => set("textSteps", value as MigrationOptions["textSteps"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="lines" label="One step per line (list numbers are removed)" />
              <Radio value="single" label="Keep as a single step" />
            </Stack>
          </Radio.Group>
          )}
          {testrail && (
          <Switch
            label="Add suite and section descriptions to the case description"
            checked={options.parentDescriptions}
            onChange={(e) => set("parentDescriptions", e.currentTarget.checked)}
          />
          )}
        </Stack>
      </Card>

      {!csv && (
      <Card withBorder>
        <Stack>
          <Title order={4}>Content</Title>
          <Switch
            label="Migrate attachments"
            description={xray ? "Attachments of the Jira issue, images inside its text and files of Xray steps." : "Case attachments and images inside text and steps."}
            checked={options.migrateAttachments}
            onChange={(e) => set("migrateAttachments", e.currentTarget.checked)}
          />
          <Switch
            label={xray ? "Called tests become shared steps" : "Migrate shared steps"}
            description={
              xray
                ? "A step that calls another test becomes an Allure TestOps shared step with the called test's steps. When off, those steps are copied into each case."
                : "TestRail shared steps become Allure TestOps shared steps. When off, their steps are copied into each case."
            }
            checked={options.migrateSharedSteps}
            onChange={(e) => set("migrateSharedSteps", e.currentTarget.checked)}
          />
          {testrail && (
          <Switch
            label="Include deleted cases"
            description="Only for TestRail versions that expose deleted cases through the API."
            checked={options.includeDeleted}
            onChange={(e) => set("includeDeleted", e.currentTarget.checked)}
          />
          )}
        </Stack>
      </Card>
      )}

      <Card withBorder>
        <Stack>
          <Title order={4}>Performance</Title>
          <NumberInput
            label="Cases migrated in parallel"
            description={
              csv
                ? "Higher is faster but puts more load on Allure TestOps."
                : xray
                  ? "Higher is faster but puts more load on Jira, Xray and Allure TestOps."
                  : "Higher is faster but puts more load on both servers. The TestRail rate limit (step 1) caps the pace regardless of this value."
            }
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
