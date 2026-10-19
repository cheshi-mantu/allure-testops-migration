import { Alert, Card, NumberInput, Radio, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { useEffect } from "react";
import { isFileSource, type MigrationOptions } from "@atm/shared";
import { useProfile } from "../../components/ProfileContext";

export function OptionsStep() {
  const { profile, update, testops } = useProfile();
  const options = profile.options;
  // Integrations of the target project, for test keys.
  const projectChosen = Boolean(profile.testops.scope.projectId);
  useEffect(() => {
    if (profile.source === "xray" && projectChosen && !testops.data && !testops.isFetching && !testops.error) {
      void testops.refetch();
    }
  }, [profile.source, projectChosen, testops]);
  const integrations = testops.data?.integrations ?? [];
  const chosenIntegration = options.testKeyIntegrationId;
  // A file source: CSV or XML.
  const csv = isFileSource(profile.source);
  const xml = profile.source === "xml";
  const xray = profile.source === "xray";
  const qase = profile.source === "qase";
  const alm = profile.source === "alm";
  const zephyr = profile.source === "zephyr";
  const squad = profile.source === "squad";
  /** Tests kept as Jira issues. */
  const jiraIssues = xray || squad;
  /** Sources whose cases have a key worth keeping as an Allure TestOps test key. */
  const keyed = jiraIssues || zephyr;
  const testrail = profile.source === "testrail";
  /** Another Allure TestOps: text is Markdown on both sides and moves as it is. */
  const copy = profile.source === "testops";
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
                : copy
                  ? `Every case gets the tag "${prefixShown}:<id of the case in the source>", e.g. "${prefixShown}:12344". Reruns find cases by this tag and update them.`
                  : alm
                  ? `Every case gets the tag "${prefixShown}:<test id>", e.g. "${prefixShown}:1024". Reruns find cases by this tag and update them.`
                  : qase
                  ? `Every case gets the tag "${prefixShown}:<project code>-<case id>", e.g. "${prefixShown}:demo-12". Reruns find cases by this tag and update them.`
                  : zephyr
                  ? `Every case gets the tag "${prefixShown}:<test case key>", e.g. "${prefixShown}:calc-t12". Reruns find cases by this tag and update them.`
                  : jiraIssues
                  ? `Every case gets the tag "${prefixShown}:<issue key>", e.g. "${prefixShown}:calc-12". Reruns find cases by this tag and update them.`
                  : `Every case gets the tag "${prefixShown}:<TestRail id>". Reruns find cases by this tag and update them. Keep "testrail" to continue a migration made with the previous migration tool.`
            }
            placeholder={xml ? "e.g. xml-regression" : csv ? "e.g. csv-regression" : xray ? "xray" : squad ? "squad" : zephyr ? "zephyr" : qase ? "qase" : alm ? "alm" : copy ? "old_id" : "testrail"}
            value={options.migrationTagPrefix}
            error={prefixMissing ? "Enter a prefix. Without it migrated cases cannot be found again, so the migration cannot start." : undefined}
            onChange={(e) => set("migrationTagPrefix", e.currentTarget.value.trim())}
          />
          <TextInput
            label="Additional tag"
            description={`Optional tag added to every migrated case, e.g. “from-${xray ? "xray" : squad ? "squad" : zephyr ? "zephyr" : qase ? "qase" : alm ? "alm" : xml ? "xml" : csv ? "csv" : "testrail"}”.`}
            value={options.additionalTag}
            onChange={(e) => set("additionalTag", e.currentTarget.value)}
          />
          {!csv && !alm && (
          <Switch
            label={jiraIssues ? "Link back to the Jira issue" : zephyr ? "Link back to the Zephyr test case" : qase ? "Link back to the Qase case" : copy ? "Link back to the case in the source Allure TestOps" : "Link back to the TestRail case"}
            description={jiraIssues ? "A link named after the issue key, e.g. \"Jira CALC-12\", in the Links of the case." : zephyr ? "A link named after the key, e.g. \"Zephyr CALC-T12\", to the Zephyr page of the Jira project. Off by default: the address of that page is not verified on a real Zephyr yet." : qase ? "A link named after the case, e.g. \"Qase DEMO-12\", in the Links of the case." : undefined}
            checked={options.selfLink}
            onChange={(e) => set("selfLink", e.currentTarget.checked)}
          />
          )}
          {keyed && (
            <Select
              label={zephyr ? "Test case key as a test key" : "Issue key as a test key"}
              description={zephyr ? "Writes the test case key, e.g. CALC-T12, to the Test keys of the case through an integration of the Allure TestOps project." : "Writes the issue key, e.g. CALC-12, to the Test keys of the case through an integration of the Allure TestOps project, such as Xray or Jira."}
              placeholder={testops.isFetching ? "Loading integrations…" : "Do not add a test key"}
              clearable
              data={[
                ...integrations.map((i) => ({ value: String(i.id), label: i.name })),
                ...(chosenIntegration && !integrations.some((i) => i.id === chosenIntegration)
                  ? [{ value: String(chosenIntegration), label: `Integration #${chosenIntegration}` }]
                  : []),
              ]}
              value={chosenIntegration ? String(chosenIntegration) : null}
              onChange={(value) => set("testKeyIntegrationId", value ? Number(value) : null)}
            />
          )}
          {keyed && chosenIntegration && testops.data && !integrations.some((i) => i.id === chosenIntegration) && (
            <Alert color="red">This integration is not enabled in the Allure TestOps project any more. Choose another one or clear the field.</Alert>
          )}
          {keyed && projectChosen && testops.data && integrations.length === 0 && (
            <Text size="xs" c="dimmed">
              The Allure TestOps project has no enabled integration. Add one in the project settings (Integrations) to write test keys.
            </Text>
          )}
        </Stack>
      </Card>

      <Card withBorder>
        <Stack>
          <Title order={4}>Text</Title>
          {copy && (
            <Text size="sm" c="dimmed">
              Text is Markdown in both Allure TestOps instances and is copied as it is; images in text point to the copied files.
            </Text>
          )}
          {!jiraIssues && !copy && !alm && !zephyr && (
          <Radio.Group
            label={csv ? "Text format" : qase ? "Qase text format" : "TestRail text format"}
            description={xml ? "Text in the file may be Markdown or HTML." : csv ? "Text cells may hold Markdown or HTML." : qase ? "Qase keeps text as Markdown; text written in an older editor may be HTML." : "Newer TestRail versions store HTML; older ones use Markdown."}
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
          {alm && (
            <Text size="sm" c="dimmed">
              ALM rich text is converted to Markdown; pictures in it, kept by ALM as attachments of the test or step, become attachments of the case. Test parameters such as &lt;&lt;&lt;amount&gt;&gt;&gt; stay in the text as they are.
            </Text>
          )}
          {zephyr && (
            <Text size="sm" c="dimmed">
              Zephyr rich text is converted to Markdown; pictures that are files of the test case or its steps become attachments of the case. Values of a call to another test case replace its {"{name}"} placeholders.
            </Text>
          )}
          {squad && (
            <Text size="sm" c="dimmed">
              Jira rich text and the wiki markup of Zephyr Squad steps are converted to Markdown; images in Jira text become attachments of the case.
            </Text>
          )}
          {xray && (
            <Text size="sm" c="dimmed">
              Jira rich text and Xray wiki markup are converted to Markdown; images in Jira text become attachments of the case.
            </Text>
          )}
          {!csv && !copy && (
          <Radio.Group
            label={xray ? "Generic definitions and other text mapped to the scenario" : squad ? "Jira text mapped to the scenario" : zephyr ? "Plain text scripts and other text mapped to the scenario" : "Steps written as plain text"}
            value={options.textSteps}
            onChange={(value) => set("textSteps", value as MigrationOptions["textSteps"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="lines" label="One step per line (list numbers are removed)" />
              <Radio value="single" label="Keep as a single step" />
            </Stack>
          </Radio.Group>
          )}
          {!copy && (
          <Radio.Group
            label="Tables of Gherkin Examples"
            description="The table under Examples: of a Scenario Outline, in any text mapped to the scenario."
            value={options.gherkinExamples}
            onChange={(value) => set("gherkinExamples", value as MigrationOptions["gherkinExamples"])}
          >
            <Stack gap={6} mt="xs">
              <Radio value="attachment" label="A Markdown file of the Examples step" description="The table stays one table, attached to the step that says Examples." />
              <Radio
                value="examples"
                label="Examples of the test case"
                description="Every row becomes an example with the column titles as parameter names; the Examples step is left out of the scenario."
              />
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
            description={xray ? "Attachments of the Jira issue, images inside its text and files of Xray steps." : squad ? "Attachments of the Jira issue, images inside its text and files of Zephyr Squad steps." : zephyr ? "Files of the test cases and of their steps, and pictures inside text." : alm ? "Attachments of the tests and of their design steps, and pictures inside text. Attachments that are addresses become links." : copy ? "Every file of the cases and of the shared steps." : qase ? "Files of the cases and of their steps, and images inside text that Qase keeps." : "Case attachments and images inside text and steps."}
            checked={options.migrateAttachments}
            onChange={(e) => set("migrateAttachments", e.currentTarget.checked)}
          />
          {!squad && (
          <Switch
            label={xray || alm ? "Called tests become shared steps" : zephyr ? "Called test cases become shared steps" : "Migrate shared steps"}
            description={
              zephyr
                ? "A step that calls another test case becomes an Allure TestOps shared step with its steps. A call with parameter values, and every call when this is off, gets the steps copied in with the values."
                : xray || alm
                ? "A step that calls another test becomes an Allure TestOps shared step with the called test's steps. When off, those steps are copied into each case."
                : `${qase ? "Qase" : copy ? "Source" : "TestRail"} shared steps become Allure TestOps shared steps. When off, their steps are copied into each case.`
            }
            checked={options.migrateSharedSteps}
            onChange={(e) => set("migrateSharedSteps", e.currentTarget.checked)}
          />
          )}
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
                : qase
                  ? "Higher is faster but puts more load on Allure TestOps. Reading from Qase is paced by the rate limit of its plan (step 1) regardless of this value."
                  : xray
                  ? "Higher is faster but puts more load on Jira, Xray and Allure TestOps."
                  : alm
                  ? "Higher is faster but puts more load on ALM and Allure TestOps."
                  : squad
                  ? "Higher is faster but puts more load on Allure TestOps. Jira and Zephyr Squad are read before writing starts, paced by \"Requests per minute\" (Connections)."
                  : zephyr
                  ? "Higher is faster but puts more load on Allure TestOps. Zephyr is read before writing starts, paced by \"Requests per minute\" (Connections)."
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
