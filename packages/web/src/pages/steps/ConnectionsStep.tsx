import { Alert, Anchor, Autocomplete, Button, Card, Collapse, Group, NumberInput, PasswordInput, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SECRET_MASK, TESTRAIL_RATE_LIMITS, XRAY_REGIONS, type TestRailConnection } from "@atm/shared";
import { api, errorText, type CheckResult } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";

function CheckAlert({ result, error }: { result?: CheckResult; error: unknown }) {
  if (error) {
    return <Alert color="red" icon={<IconAlertCircle size={16} />}>{errorText(error)}</Alert>;
  }
  if (!result) {
    return null;
  }
  return (
    <Alert color={result.ok ? "green" : "red"} icon={result.ok ? <IconCircleCheck size={16} /> : <IconAlertCircle size={16} />}>
      {result.message}
    </Alert>
  );
}

const CLOUD_HOST = /\.testrail\.(io|net|com)$/i;

function rateLimitHint(endpoint: string, mode: TestRailConnection["rateLimit"]): string {
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    // Not a URL yet.
  }
  const base = "TestRail Cloud limits API requests per instance, shared with everyone using the API. Requests are paced to stay below it.";
  if (host && !CLOUD_HOST.test(host) && mode !== "off") {
    return `${base} This looks like a TestRail Server, which has no limit: you can turn it off.`;
  }
  if (host && CLOUD_HOST.test(host) && mode === "off") {
    return "This looks like TestRail Cloud: without a limit TestRail may reject requests and the migration slows down on retries.";
  }
  return base;
}

const secretPlaceholder = (value: string) => (value === SECRET_MASK ? "Stored. Type to replace it" : undefined);
const secretValue = (value: string) => (value === SECRET_MASK ? "" : value);

export function ConnectionsStep() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const tr = profile.testrail.connection;
  const to = profile.testops.connection;
  const [advanced, setAdvanced] = useState(Boolean(secretValue(tr.sessionCookie) || tr.sessionCookie === SECRET_MASK));

  const checkTestRail = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkTestRail(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "testrail", profile.id], result.projects),
  });
  const checkTestOps = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkTestOps(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "testops", profile.id], result.projects),
  });

  return (
    <Stack>
      <Text c="dimmed">
        Credentials are stored only in this tool's data volume and are never included in an export unless you ask for it.
      </Text>
      <SimpleGrid cols={{ base: 1, lg: profile.source === "csv" ? 1 : 2 }} maw={profile.source === "csv" ? 640 : undefined}>
        {profile.source === "xray" && <XrayConnectionCard />}
        {profile.source === "testrail" && (
        <Card withBorder>
          <Stack>
            <Title order={4}>TestRail (source)</Title>
            <TextInput
              label="TestRail URL"
              placeholder="https://yourcompany.testrail.io/"
              value={tr.endpoint}
              onChange={(e) => {
                const value = e.currentTarget.value;
                update((p) => void (p.testrail.connection.endpoint = value));
              }}
            />
            <TextInput
              label="User email"
              value={tr.username}
              onChange={(e) => {
                const value = e.currentTarget.value;
                update((p) => void (p.testrail.connection.username = value));
              }}
            />
            <PasswordInput
              label="API key"
              description={
                <>
                  Create one in TestRail under <i>My Settings → API Keys</i>. The API must be enabled in the site settings.
                </>
              }
              placeholder={secretPlaceholder(tr.apiKey)}
              value={secretValue(tr.apiKey)}
              onChange={(e) => {
                const value = e.currentTarget.value;
                update((p) => void (p.testrail.connection.apiKey = value));
              }}
            />
            <Select
              label="API rate limit"
              description={rateLimitHint(tr.endpoint, tr.rateLimit)}
              allowDeselect={false}
              data={[
                { value: "professional", label: `TestRail Cloud Professional: ${TESTRAIL_RATE_LIMITS.professional} requests per minute` },
                { value: "enterprise", label: `TestRail Cloud Enterprise: ${TESTRAIL_RATE_LIMITS.enterprise} requests per minute` },
                { value: "custom", label: "Custom" },
                { value: "off", label: "Off (TestRail Server has no limit)" },
              ]}
              value={tr.rateLimit}
              onChange={(value) => value && update((p) => void (p.testrail.connection.rateLimit = value as TestRailConnection["rateLimit"]))}
            />
            {tr.rateLimit === "custom" && (
              <NumberInput
                label="Requests per minute"
                description="Useful to leave room for other API users of the same TestRail, such as CI jobs posting results."
                min={1}
                max={100000}
                w={260}
                value={tr.requestsPerMinute}
                onChange={(value) => update((p) => void (p.testrail.connection.requestsPerMinute = Math.max(1, Math.floor(Number(value) || 1))))}
              />
            )}
            <Anchor size="sm" component="button" type="button" onClick={() => setAdvanced((v) => !v)} ta="left">
              {advanced ? "Hide" : "Show"} advanced settings
            </Anchor>
            <Collapse expanded={advanced}>
              <Stack>
                <PasswordInput
                  label="Session cookie (optional)"
                  description="Only needed when inline images fail to migrate: some TestRail versions serve them to a logged-in browser only. Copy the tr_session cookie from your browser."
                  placeholder={secretPlaceholder(tr.sessionCookie) ?? "tr_session=..."}
                  value={secretValue(tr.sessionCookie)}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    update((p) => void (p.testrail.connection.sessionCookie = value));
                  }}
                />
                <Switch
                  label="Skip TLS certificate verification"
                  description="For servers with self-signed certificates."
                  checked={tr.insecureTls}
                  onChange={(e) => {
                    const value = e.currentTarget.checked;
                    update((p) => void (p.testrail.connection.insecureTls = value));
                  }}
                />
              </Stack>
            </Collapse>
            <Group>
              <Button variant="light" loading={checkTestRail.isPending} onClick={() => checkTestRail.mutate()}>
                Test connection
              </Button>
            </Group>
            <CheckAlert result={checkTestRail.data} error={checkTestRail.error} />
          </Stack>
        </Card>
        )}

        <Card withBorder>
          <Stack>
            <Title order={4}>Allure TestOps (target)</Title>
            <TextInput
              label="Allure TestOps URL"
              placeholder="https://testops.yourcompany.com/"
              value={to.endpoint}
              onChange={(e) => {
                const value = e.currentTarget.value;
                update((p) => void (p.testops.connection.endpoint = value));
              }}
            />
            <PasswordInput
              label="API token"
              description={
                <>
                  Create one in Allure TestOps under <i>Your profile → API tokens</i>. The account needs write access to the target project.
                </>
              }
              placeholder={secretPlaceholder(to.apiToken)}
              value={secretValue(to.apiToken)}
              onChange={(e) => {
                const value = e.currentTarget.value;
                update((p) => void (p.testops.connection.apiToken = value));
              }}
            />
            <Switch
              label="Skip TLS certificate verification"
              description="For servers with self-signed certificates."
              checked={to.insecureTls}
              onChange={(e) => {
                const value = e.currentTarget.checked;
                update((p) => void (p.testops.connection.insecureTls = value));
              }}
            />
            <Group>
              <Button variant="light" loading={checkTestOps.isPending} onClick={() => checkTestOps.mutate()}>
                Test connection
              </Button>
            </Group>
            <CheckAlert result={checkTestOps.data} error={checkTestOps.error} />
          </Stack>
        </Card>
      </SimpleGrid>
    </Stack>
  );
}

/** Xray Cloud API key for test details, Jira account for the issues: both are needed. */
function XrayConnectionCard() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const xc = profile.xray.connection;
  const check = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkXray(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "xray", profile.id], result.projects),
  });
  const set = <K extends keyof typeof xc>(key: K, value: (typeof xc)[K]) => update((p) => void (p.xray.connection[key] = value));

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Xray Cloud and Jira (source)</Title>
        <Text size="sm" c="dimmed">
          Xray keeps the test details (type, steps, definitions, folders, preconditions, sets, plans), Jira keeps the issue (summary,
          description, fields, comments, links, attachments). The migration reads both.
        </Text>
        <TextInput
          label="Jira site"
          placeholder="https://yourcompany.atlassian.net"
          value={xc.jiraUrl}
          onChange={(e) => set("jiraUrl", e.currentTarget.value)}
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Jira user email" value={xc.jiraEmail} onChange={(e) => set("jiraEmail", e.currentTarget.value)} />
          <PasswordInput
            label="Atlassian API token"
            description={
              <>
                Create one at <i>id.atlassian.com → Security → API tokens</i>.
              </>
            }
            placeholder={secretPlaceholder(xc.jiraApiToken)}
            value={secretValue(xc.jiraApiToken)}
            onChange={(e) => set("jiraApiToken", e.currentTarget.value)}
          />
        </SimpleGrid>
        <Autocomplete
          label="Xray API URL"
          description={`${XRAY_REGIONS.find((r) => r.value === xc.endpoint.replace(/\/+$/, ""))?.label ?? "Custom address"}. Global fits most sites; sites with data residency use their region (us., eu. or au.).`}
          data={XRAY_REGIONS.map((r) => r.value)}
          value={xc.endpoint}
          onChange={(value) => set("endpoint", value.trim())}
        />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput
            label="Xray client id"
            description={
              <>
                An Xray API key: Jira <i>Apps → Xray → API Keys</i>.
              </>
            }
            value={xc.clientId}
            onChange={(e) => set("clientId", e.currentTarget.value)}
          />
          <PasswordInput
            label="Xray client secret"
            description="Shown once when the key is created."
            placeholder={secretPlaceholder(xc.clientSecret)}
            value={secretValue(xc.clientSecret)}
            onChange={(e) => set("clientSecret", e.currentTarget.value)}
          />
        </SimpleGrid>
        <Group>
          <Button variant="light" loading={check.isPending} onClick={() => check.mutate()}>
            Test connection
          </Button>
        </Group>
        <CheckAlert result={check.data} error={check.error} />
      </Stack>
    </Card>
  );
}
