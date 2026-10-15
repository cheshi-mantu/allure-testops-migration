import { Alert, Anchor, Autocomplete, Button, Card, Code, Collapse, CopyButton, Group, NumberInput, PasswordInput, ScrollArea, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { QASE_RATE_LIMITS, SECRET_MASK, TESTRAIL_RATE_LIMITS, XRAY_REGIONS, type AlmConnection, type QaseConnection, type TestRailConnection, type XmlFiles } from "@atm/shared";
import { api, errorText, type CheckResult } from "../../api/client";
import { useProfile } from "../../components/ProfileContext";

function CheckAlert({ result, error }: { result?: Pick<CheckResult, "ok" | "message">; error: unknown }) {
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
        {profile.source === "qase" && <QaseConnectionCard />}
        {profile.source === "alm" && <AlmConnectionCard />}
        {profile.source === "testops" && <TestOpsSourceCard />}
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
            <Title order={4}>{profile.source === "testops" ? "Target Allure TestOps" : "Allure TestOps (target)"}</Title>
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
        {profile.source === "xml" && <XmlFilesCard />}
      </SimpleGrid>
    </Stack>
  );
}

const FILE_AUTH: { value: XmlFiles["auth"]; label: string }[] = [
  { value: "basic", label: "User and password or API key" },
  { value: "header", label: "Request header, e.g. a token or a cookie" },
  { value: "none", label: "No authentication" },
];

/** An XML file holds addresses of attached files, not the files: optional access to the system that serves them. */
function XmlFilesCard() {
  const { profile, update, flush } = useProfile();
  const settings = profile.xml.files;
  const check = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkXmlFiles(profile.id);
    },
  });
  const set = <K extends keyof XmlFiles>(key: K, value: XmlFiles[K]) => update((p) => void (p.xml.files[key] = value));
  const endpoint = settings.endpoint.trim();
  const endpointError = settings.download && endpoint !== "" && !/^https?:\/\/\S+/i.test(endpoint) ? "Start the address with http:// or https://" : undefined;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Attached files (optional)</Title>
        <Text size="sm" c="dimmed">
          An XML file holds the addresses of attached files and of images inside text, not the files. Without this they stay links to
          the source system. With it the files are downloaded and attached to the cases, and images keep their place in the text.
        </Text>
        <Switch
          label="Download attached files"
          description="Files listed in fields mapped to Attachments on the Fields step, and images inside text and steps."
          checked={settings.download}
          onChange={(e) => set("download", e.currentTarget.checked)}
        />
        {settings.download && (
          <>
            <TextInput
              label="Address of the source system"
              description="Files are downloaded only from this address, and the credentials below are sent only to it. Addresses on other hosts stay links."
              placeholder="https://yourcompany.testrail.io/"
              value={settings.endpoint}
              error={endpointError}
              onChange={(e) => set("endpoint", e.currentTarget.value)}
            />
            <Select
              label="Authentication"
              allowDeselect={false}
              data={FILE_AUTH}
              value={settings.auth}
              onChange={(value) => value && set("auth", value as XmlFiles["auth"])}
            />
            {settings.auth === "basic" && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="User" placeholder="you@example.com" value={settings.username} onChange={(e) => set("username", e.currentTarget.value)} />
                <PasswordInput
                  label="Password or API key"
                  description="For TestRail: the user email and an API key from My Settings → API Keys."
                  inputWrapperOrder={["label", "input", "description", "error"]}
                  placeholder={secretPlaceholder(settings.password)}
                  value={secretValue(settings.password)}
                  onChange={(e) => set("password", e.currentTarget.value)}
                />
              </SimpleGrid>
            )}
            {settings.auth === "header" && (
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label="Header name" placeholder="Authorization" value={settings.headerName} onChange={(e) => set("headerName", e.currentTarget.value)} />
                <PasswordInput
                  label="Header value"
                  description='For example "Bearer <token>", or a session cookie for the header Cookie.'
                  inputWrapperOrder={["label", "input", "description", "error"]}
                  placeholder={secretPlaceholder(settings.headerValue)}
                  value={secretValue(settings.headerValue)}
                  onChange={(e) => set("headerValue", e.currentTarget.value)}
                />
              </SimpleGrid>
            )}
            <Switch
              label="Skip TLS certificate verification"
              description="For servers with self-signed certificates."
              checked={settings.insecureTls}
              onChange={(e) => set("insecureTls", e.currentTarget.checked)}
            />
            <Group>
              <Button variant="light" loading={check.isPending} disabled={!profile.xml.fileId} onClick={() => check.mutate()}>
                Test download
              </Button>
              {!profile.xml.fileId && (
                <Text size="sm" c="dimmed">
                  Choose the XML file first: the test downloads the first file it refers to.
                </Text>
              )}
            </Group>
            <CheckAlert result={check.data} error={check.error} />
          </>
        )}
      </Stack>
    </Card>
  );
}

const QASE_PLANS: { value: QaseConnection["rateLimit"]; label: string }[] = [
  { value: "free", label: `Free: ${QASE_RATE_LIMITS.free} requests per minute` },
  { value: "startup", label: `Startup: ${QASE_RATE_LIMITS.startup} requests per minute` },
  { value: "business", label: `Teams or Business: ${QASE_RATE_LIMITS.business} requests per minute` },
  { value: "enterprise", label: `Enterprise: ${QASE_RATE_LIMITS.enterprise} requests per minute` },
];

/** The Allure TestOps the projects are copied from. */
function TestOpsSourceCard() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const sc = profile.testopsSource.connection;
  const check = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkTestOpsSource(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "testops-source", profile.id], result.projects),
  });
  const set = <K extends keyof typeof sc>(key: K, value: (typeof sc)[K]) => update((p) => void (p.testopsSource.connection[key] = value));

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Source Allure TestOps</Title>
        <Text size="sm" c="dimmed">
          The instance the projects are copied from. It is only read: a token of a user who can see the projects is enough.
        </Text>
        <TextInput label="Allure TestOps URL" placeholder="https://old-testops.yourcompany.com/" value={sc.endpoint} onChange={(e) => set("endpoint", e.currentTarget.value)} />
        <PasswordInput
          label="API token"
          description={
            <>
              Create one in the source Allure TestOps under <i>Your profile → API tokens</i>.
            </>
          }
          placeholder={secretPlaceholder(sc.apiToken)}
          value={secretValue(sc.apiToken)}
          onChange={(e) => set("apiToken", e.currentTarget.value)}
        />
        <Switch
          label="Skip TLS certificate verification"
          description="For servers with self-signed certificates."
          checked={sc.insecureTls}
          onChange={(e) => set("insecureTls", e.currentTarget.checked)}
        />
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

function QaseConnectionCard() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const qc = profile.qase.connection;
  const custom = qc.endpoint.replace(/\/+$/, "") !== "https://api.qase.io" || qc.appUrl.replace(/\/+$/, "") !== "https://app.qase.io" || qc.insecureTls;
  const [advanced, setAdvanced] = useState(custom);
  const check = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkQase(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "qase", profile.id], result.projects),
  });
  const set = <K extends keyof QaseConnection>(key: K, value: QaseConnection[K]) => update((p) => void (p.qase.connection[key] = value));

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>Qase (source)</Title>
        <PasswordInput
          label="API token"
          description={
            <>
              Create one in Qase under <i>your profile → API tokens</i>. The token reads what its user can see; the migration only reads.
            </>
          }
          placeholder={secretPlaceholder(qc.apiToken)}
          value={secretValue(qc.apiToken)}
          onChange={(e) => set("apiToken", e.currentTarget.value)}
        />
        <Select
          label="Qase plan (API rate limit)"
          description="Qase limits API requests for the whole workspace, shared with everyone and everything using its API. The tool stays below the limit of the plan and waits when Qase still asks to slow down."
          allowDeselect={false}
          data={QASE_PLANS}
          value={qc.rateLimit}
          onChange={(value) => value && set("rateLimit", value as QaseConnection["rateLimit"])}
        />
        <Anchor component="button" type="button" size="sm" ta="left" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? "Hide" : "Show"} addresses for a dedicated Qase
        </Anchor>
        <Collapse expanded={advanced}>
          <Stack>
            <TextInput
              label="Qase API address"
              description="https://api.qase.io for Qase Cloud. A dedicated or regional Qase has its own address."
              placeholder="https://api.qase.io"
              value={qc.endpoint}
              onChange={(e) => set("endpoint", e.currentTarget.value)}
            />
            <TextInput
              label="Qase web address"
              description="Where people open Qase; used for the links back to the cases."
              placeholder="https://app.qase.io"
              value={qc.appUrl}
              onChange={(e) => set("appUrl", e.currentTarget.value)}
            />
            <Switch
              label="Skip TLS certificate verification"
              description="For servers with self-signed certificates."
              checked={qc.insecureTls}
              onChange={(e) => set("insecureTls", e.currentTarget.checked)}
            />
          </Stack>
        </Collapse>
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

/** ALM login: a user and password, or an API key; the session is closed after every use. */
function AlmConnectionCard() {
  const { profile, update, flush } = useProfile();
  const queryClient = useQueryClient();
  const ac = profile.alm.connection;
  const check = useMutation({
    mutationFn: async () => {
      await flush();
      return api.checkAlm(profile.id);
    },
    onSuccess: (result) => queryClient.setQueryData(["projects", "alm", profile.id], result.projects),
  });
  const set = <K extends keyof AlmConnection>(key: K, value: AlmConnection[K]) => update((p) => void (p.alm.connection[key] = value));
  const [showDetails, setShowDetails] = useState(false);
  const details = check.data?.details;

  return (
    <Card withBorder>
      <Stack>
        <Title order={4}>ALM (source)</Title>
        <AlmNotVerified />
        <TextInput
          label="ALM address"
          description="The address people open ALM at, with or without /qcbin."
          placeholder="https://alm.example.com/qcbin"
          value={ac.endpoint}
          onChange={(e) => set("endpoint", e.currentTarget.value)}
        />
        <Select
          label="Log in with"
          allowDeselect={false}
          data={[
            { value: "password", label: "User name and password" },
            { value: "apiKey", label: "API key (ALM 12.60 and later)" },
          ]}
          value={ac.auth}
          onChange={(value) => value && set("auth", value as AlmConnection["auth"])}
        />
        {ac.auth === "apiKey" ? (
          <>
            <TextInput
              label="Client ID"
              description="An API key is created in ALM Site Administration (Site Users, API Keys) for a user."
              value={ac.clientId}
              onChange={(e) => set("clientId", e.currentTarget.value)}
            />
            <PasswordInput label="Secret" placeholder={secretPlaceholder(ac.secret)} value={secretValue(ac.secret)} onChange={(e) => set("secret", e.currentTarget.value)} />
          </>
        ) : (
          <>
            <TextInput label="User name" value={ac.username} onChange={(e) => set("username", e.currentTarget.value)} />
            <PasswordInput label="Password" placeholder={secretPlaceholder(ac.password)} value={secretValue(ac.password)} onChange={(e) => set("password", e.currentTarget.value)} />
          </>
        )}
        <Text size="xs" c="dimmed">
          The user must be a member of the project and allowed to read its Test Plan; the migration only reads. The tool opens one session for a check, preview or migration and logs out as soon as it is done.
        </Text>
        <Switch
          label="Skip TLS certificate verification"
          description="For servers with self-signed certificates."
          checked={ac.insecureTls}
          onChange={(e) => set("insecureTls", e.currentTarget.checked)}
        />
        <Switch
          label="Detailed log"
          description="Every request to ALM with its answer status and time, the structure of the answers (field names and kinds of values, file names, not the text of tests) and what was read for each test go to the log of the connection check and of every run. Passwords, secrets and cookies are never written."
          checked={profile.alm.detailedLog}
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            update((p) => void (p.alm.detailedLog = checked));
          }}
        />
        <Group>
          <Button variant="light" loading={check.isPending} onClick={() => check.mutate()}>
            Test connection
          </Button>
        </Group>
        <CheckAlert result={check.data} error={check.error} />
        {details && (
          <Stack gap="xs">
            <Group gap="xs">
              <Anchor component="button" type="button" size="sm" onClick={() => setShowDetails((v) => !v)}>
                {showDetails ? "Hide" : "Show"} the detailed log of this check
              </Anchor>
              <CopyButton value={details}>
                {({ copied, copy }) => (
                  <Button size="compact-xs" variant="default" onClick={copy}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Collapse expanded={showDetails}>
              <ScrollArea.Autosize mah={260} type="auto">
                <Code block fz="xs">
                  {details}
                </Code>
              </ScrollArea.Autosize>
            </Collapse>
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/** The ALM migration is built from the public REST API reference and a simulated ALM only. */
export function AlmNotVerified() {
  return (
    <Alert color="yellow" title="Not yet verified on a real ALM server">
      The ALM migration is built from the public ALM REST API reference and tested against a simulated ALM only. Check the connection, look at a few tests on the Preview step and do a dry run before the
      migration. If something fails or looks wrong, keep <i>Detailed log</i> on, download the log of the run (Run step, <i>Download log</i>) or copy the log of the connection check, and send it with a
      description of the problem: it holds no passwords or secrets, and no text of the tests.
    </Alert>
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
