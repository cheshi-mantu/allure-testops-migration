/**
 * Fills a Jira Cloud project with Xray tests that cover everything the migration reads, to try the
 * tool against a real Xray Cloud. Every created issue gets the label `atm-seed`.
 *
 *   JIRA_URL=https://you.atlassian.net JIRA_EMAIL=you@example.com JIRA_API_TOKEN=... \
 *   XRAY_CLIENT_ID=... XRAY_CLIENT_SECRET=... [XRAY_URL=https://eu.xray.cloud.getxray.app] \
 *   npx tsx dev/xray-seed.ts --project XFMTT [--bulk 300]
 *
 * Besides a few hand-made edge cases it creates the scenarios of dev/xray-seed-scenarios.ts once each;
 * `--bulk N` adds N more tests made from variations of them (browsers, locales, roles, negative input),
 * with step shapes that vary: as written, steps only, no expected results, a check at the end, long.
 *
 *   npx tsx dev/xray-seed.ts --project XFMTT --cleanup --yes    # deletes every issue labelled atm-seed
 *
 * The project needs the Xray issue types (Test, Precondition, Test Set, Test Plan) and Story.
 */
import { JiraClient, XrayClient } from "../packages/server/src/xray/client.js";
import { COMPONENTS, folderPaths, generate, SCENARIOS, VERSIONS, type GeneratedTest, type PreconditionName } from "./xray-seed-scenarios.js";

const LABEL = "atm-seed";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);

/** Stops with a plain message, no stack trace: these are usage errors. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const projectKey = option("project");
const bulk = Number(option("bulk") ?? 0);
const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    fail(`Set the environment variable ${name}. See the top of dev/xray-seed.ts.`);
  }
  return value;
};
if (!projectKey) {
  fail("Pass the Jira project key: --project KEY.");
}

const connection = {
  endpoint: env("XRAY_URL", "https://xray.cloud.getxray.app"),
  clientId: env("XRAY_CLIENT_ID"),
  clientSecret: env("XRAY_CLIENT_SECRET"),
  jiraUrl: env("JIRA_URL"),
  jiraEmail: env("JIRA_EMAIL"),
  jiraApiToken: env("JIRA_API_TOKEN"),
};
const log = (message: string) => console.log(message);
const jira = new JiraClient(connection, (info) => log(`  retry ${info.attempt}/${info.of}: ${info.reason}`));
const xray = new XrayClient(connection, (info) => log(`  retry ${info.attempt}/${info.of}: ${info.reason}`));
// Jira refuses attachment uploads without it.
jira.http.setHeader("X-Atlassian-Token", "no-check");

/** Runs a step, reports a failure and goes on: one missing permission should not stop the rest. */
async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log(`  ! ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ------------------------------------------------------------------ files

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mNk+M+AFTAxkAhGNYxqGNUwqmFUw6iGUQ2jGgYJAAA8TwEQ2XtoNQAAAABJRU5ErkJggg==",
  "base64",
);
const CSV = Buffer.from("login,password\njane,secret\nsam,hunter2\n");
const file = (filename: string, data: Buffer, mimeType: string) => ({ filename, mimeType, data: data.toString("base64") });

// ------------------------------------------------------------------ Jira

let projectId = "";
let accountId = "";

async function prepareProject() {
  const project = await jira.http.get<{ id: string; key: string; name: string }>(`rest/api/3/project/${projectKey}`);
  projectId = project.id;
  accountId = (await jira.myself()).accountId;
  log(`Project ${project.name} (${project.key}, id ${project.id}).`);
  for (const name of COMPONENTS) {
    await attempt(`component ${name}`, () => jira.http.json("POST", "rest/api/3/component", { body: { name, project: projectKey } }));
  }
  for (const name of VERSIONS) {
    await attempt(`version ${name}`, () => jira.http.json("POST", "rest/api/3/version", { body: { name, projectId: Number(projectId) } }));
  }
}

/** Jira fields for a new issue; description and comments are set later in wiki markup through REST v2. */
function jiraFields(summary: string, extra: Record<string, unknown> = {}) {
  return { fields: { summary, project: { key: projectKey }, labels: [LABEL, ...((extra.labels as string[]) ?? [])], ...withoutLabels(extra) } };
}
function withoutLabels(extra: Record<string, unknown>) {
  const { labels: _labels, ...rest } = extra;
  return rest;
}

async function story(summary: string): Promise<string | null> {
  const created = await attempt(`story "${summary}"`, () =>
    jira.http.json<{ key: string }>("POST", "rest/api/3/issue", {
      body: { fields: { project: { key: projectKey }, issuetype: { name: "Story" }, summary, labels: [LABEL] } },
    }),
  );
  return created?.key ?? null;
}

async function describe(key: string, description: string, environment?: string) {
  await attempt(`description of ${key}`, () =>
    jira.http.json("PUT", `rest/api/2/issue/${key}`, { body: { fields: { description, ...(environment ? { environment } : {}) } } }),
  );
}

async function comment(key: string, body: string) {
  await attempt(`comment on ${key}`, () => jira.http.json("POST", `rest/api/2/issue/${key}/comment`, { body: { body } }));
}

async function attach(key: string, name: string, data: Buffer, type: string) {
  await attempt(`attachment ${name} on ${key}`, () =>
    jira.http.upload(`rest/api/3/issue/${key}/attachments`, {}, [{ field: "file", name, data, contentType: type }]),
  );
}

async function link(type: string, from: string, to: string) {
  // The inward issue gets the outward description: "<from> tests <to>".
  await attempt(`link ${from} ${type} ${to}`, () =>
    jira.http.json("POST", "rest/api/3/issueLink", { body: { type: { name: type }, inwardIssue: { key: from }, outwardIssue: { key: to } } }),
  );
}

// ------------------------------------------------------------------ Xray

interface Created {
  issueId: string;
  key: string;
}

const KEY_FIELDS = `jira(fields: ["key"])`;

async function folder(path: string) {
  await attempt(`folder ${path}`, () =>
    xray.query(`mutation($projectId: String, $path: String!) { createFolder(projectId: $projectId, path: $path) { warnings } }`, { projectId, path }),
  );
}

async function test(input: {
  summary: string;
  type: "Manual" | "Cucumber" | "Generic";
  steps?: Record<string, unknown>[];
  gherkin?: string;
  unstructured?: string;
  folderPath?: string;
  preconditions?: Created[];
  jira?: Record<string, unknown>;
}): Promise<Created | null> {
  const created = await attempt(`test "${input.summary}"`, async () => {
    const result = await xray.query<{ createTest: { test: { issueId: string; jira: { key: string } }; warnings?: string[] } }>(
      `mutation($testType: UpdateTestTypeInput, $steps: [CreateStepInput], $gherkin: String, $unstructured: String, $folderPath: String, $preconditionIssueIds: [String], $jira: JSON!) {
        createTest(testType: $testType, steps: $steps, gherkin: $gherkin, unstructured: $unstructured, folderPath: $folderPath, preconditionIssueIds: $preconditionIssueIds, jira: $jira) {
          test { issueId ${KEY_FIELDS} } warnings
        }
      }`,
      {
        testType: { name: input.type },
        steps: input.steps,
        gherkin: input.gherkin,
        unstructured: input.unstructured,
        folderPath: input.folderPath,
        preconditionIssueIds: input.preconditions?.map((p) => p.issueId),
        jira: jiraFields(input.summary, input.jira),
      },
    );
    result.createTest.warnings?.forEach((warning) => log(`  warning: ${warning}`));
    return created_(result.createTest.test);
  });
  if (created) {
    log(`  ${created.key} ${input.type}: ${input.summary}`);
  }
  return created;
}

/** Issue id and key of a created issue; fails clearly when Xray answered without them. */
function created_(issue: { issueId?: string; jira?: { key?: string } } | null | undefined): Created {
  if (!issue?.issueId || !issue.jira?.key) {
    throw new Error(`Xray answered without the created issue: ${JSON.stringify(issue)}`);
  }
  return { issueId: issue.issueId, key: issue.jira.key };
}

async function precondition(summary: string, definition: string): Promise<Created | null> {
  return attempt(`precondition "${summary}"`, async () => {
    const result = await xray.query<{ createPrecondition?: { precondition?: { issueId: string; jira: { key: string } } } }>(
      `mutation($definition: String, $jira: JSON!) {
        createPrecondition(preconditionType: { name: "Manual" }, definition: $definition, jira: $jira) { precondition { issueId ${KEY_FIELDS} } warnings }
      }`,
      { definition, jira: jiraFields(summary) },
    );
    return created_(result?.createPrecondition?.precondition);
  });
}

/** Tests per request when adding to a set or plan. */
const CHUNK = 100;

async function testSet(summary: string, tests: Created[]) {
  const created = await attempt(`test set "${summary}"`, async () => {
    const result = await xray.query<{ createTestSet?: { testSet?: { issueId: string; jira: { key: string } } } }>(
      `mutation($testIssueIds: [String], $jira: JSON!) { createTestSet(testIssueIds: $testIssueIds, jira: $jira) { testSet { issueId ${KEY_FIELDS} } warnings } }`,
      { testIssueIds: tests.slice(0, CHUNK).map((t) => t.issueId), jira: jiraFields(summary) },
    );
    return created_(result?.createTestSet?.testSet);
  });
  if (!created) {
    return;
  }
  for (let i = CHUNK; i < tests.length; i += CHUNK) {
    await attempt(`add tests to ${created.key}`, () =>
      xray.query(`mutation($issueId: String!, $testIssueIds: [String]!) { addTestsToTestSet(issueId: $issueId, testIssueIds: $testIssueIds) { warning } }`, {
        issueId: created.issueId,
        testIssueIds: tests.slice(i, i + CHUNK).map((t) => t.issueId),
      }),
    );
  }
  log(`  ${created.key} Test set: ${summary} (${tests.length} tests)`);
}

async function testPlan(summary: string, tests: Created[]) {
  const created = await attempt(`test plan "${summary}"`, async () => {
    const result = await xray.query<{ createTestPlan?: { testPlan?: { issueId: string; jira: { key: string } } } }>(
      `mutation($testIssueIds: [String], $jira: JSON!) { createTestPlan(testIssueIds: $testIssueIds, jira: $jira) { testPlan { issueId ${KEY_FIELDS} } warnings } }`,
      { testIssueIds: tests.slice(0, CHUNK).map((t) => t.issueId), jira: jiraFields(summary) },
    );
    return created_(result?.createTestPlan?.testPlan);
  });
  if (!created) {
    return;
  }
  for (let i = CHUNK; i < tests.length; i += CHUNK) {
    await attempt(`add tests to ${created.key}`, () =>
      xray.query(`mutation($issueId: String!, $testIssueIds: [String]!) { addTestsToTestPlan(issueId: $issueId, testIssueIds: $testIssueIds) { warning } }`, {
        issueId: created.issueId,
        testIssueIds: tests.slice(i, i + CHUNK).map((t) => t.issueId),
      }),
    );
  }
  log(`  ${created.key} Test plan: ${summary} (${tests.length} tests)`);
}

// ------------------------------------------------------------------ the data set

async function seed() {
  await prepareProject();
  const present = <T>(items: (T | null)[]) => items.filter((item): item is T => item !== null);

  log("Requirements");
  const loginStory = await story("Users can log in with email and password");
  const checkoutStory = await story("Customers can pay by card");
  const blocker = await story("Payment provider sandbox is available");

  const generated = generate(SCENARIOS.length + bulk);
  log("Folders");
  const handMade = ["/Web/Auth/Login/Errors", "/Web/Shop/Checkout", "/API/v2", "/Mobile", "/Common"].map((path) => ({ folder: path }));
  for (const path of folderPaths([...handMade, ...generated] as GeneratedTest[])) {
    await folder(path);
  }

  log("Preconditions");
  const userExists = await precondition("User jane exists", "*User* {{jane@example.com}} exists and is *active*.\n* role: customer\n* password: see the test data");
  const cartFilled = await precondition("Cart has two items", "The cart holds:\n||Item||Qty||\n|Phone|1|\n|Case|2|");
  const sandbox = await precondition("Payment sandbox is up", "Check [the status page|https://status.example.com] first.");
  const adminUser = await precondition("Admin account exists", "User {{admin@example.com}} has the *Administrator* role.");
  const device = await precondition("Test phone is ready", "||Device||OS||App||\n|iPhone 15|iOS 18|latest TestFlight build|\n|Pixel 8|Android 15|latest internal build|");
  const emptyDb = await precondition("Database is empty", "Run {{make reset-db}} on the test environment.");
  const pool: Record<PreconditionName, Created | null> = { user: userExists, admin: adminUser, cart: cartFilled, sandbox, device, emptyDb };
  const many: Created[] = [];
  for (let i = 1; i <= 12; i++) {
    const created = await precondition(`Feature flag ${i} is on`, `Turn on flag _feature-${i}_ in the admin panel.`);
    if (created) many.push(created);
  }

  log("Called tests");
  const openApp = await test({
    summary: "Open the app and accept cookies",
    type: "Manual",
    folderPath: "/Common",
    steps: [
      { action: "Start the app", result: "The start page is shown" },
      { action: "Accept *all* cookies", result: "The banner disappears" },
    ],
  });
  const logIn = await test({
    summary: "Log in as jane",
    type: "Manual",
    folderPath: "/Common",
    steps: [
      ...(openApp ? [{ callTestIssueId: openApp.issueId }] : []),
      { action: "Enter {{jane@example.com}} and the password", result: "The dashboard opens" },
    ],
  });

  log("Manual tests");
  const manual = present([
    await test({
      summary: "Login with valid credentials",
      type: "Manual",
      folderPath: "/Web/Auth/Login",
      preconditions: present([userExists]),
      jira: { labels: ["smoke", "login"], priority: { name: "High" }, components: [{ name: "Auth" }], fixVersions: [{ name: "1.0" }], assignee: { accountId } },
      steps: [
        { action: "Open the *login* page", data: "URL: {{/login}}", result: "The form is shown" },
        {
          action: "Enter valid credentials !credentials.png|thumbnail!",
          data: "||User||Password||\n|jane|secret|",
          result: "Fields are filled",
          attachments: [file("credentials.png", PNG, "image/png"), file("users.csv", CSV, "text/csv")],
        },
        { action: "Press _Log in_", result: "* The dashboard opens\n* The user name is shown in the header" },
      ],
    }),
    await test({
      summary: "Login with a wrong password shows an error",
      type: "Manual",
      folderPath: "/Web/Auth/Login/Errors",
      preconditions: present([userExists]),
      jira: { labels: ["login", "negative"], priority: { name: "Medium" }, components: [{ name: "Auth" }] },
      steps: [
        { action: "Open the login page", result: "" },
        { action: "Enter jane and the password {{wrong}}", result: "The message _Wrong email or password_ is shown in {color:red}red{color}" },
        { action: "", data: "Step without an action", result: "Nothing else happens" },
      ],
    }),
    await test({
      summary: "Checkout with a card",
      type: "Manual",
      folderPath: "/Web/Shop/Checkout",
      preconditions: present([cartFilled, sandbox]),
      jira: { labels: ["checkout", "regression"], priority: { name: "Highest" }, components: [{ name: "Checkout" }], fixVersions: [{ name: "2.0" }] },
      steps: [
        ...(logIn ? [{ callTestIssueId: logIn.issueId }] : []),
        { action: "Open the cart", result: "Two items are listed" },
        { action: "Pay with card", data: "{code:json}\n{\"card\": \"4242 4242 4242 4242\", \"cvc\": \"123\"}\n{code}", result: "The order is placed" },
      ],
    }),
    await test({
      summary: "Feature flags are applied after login",
      type: "Manual",
      folderPath: "/Web",
      preconditions: many,
      jira: { labels: ["flags"], priority: { name: "Low" } },
      steps: [{ action: "Log in", result: "All flags from the preconditions are on" }],
    }),
    await test({
      summary: "Тест с кириллицей и спецсимволами: [скобки], *звёздочки*, \\обратные слэши\\",
      type: "Manual",
      jira: { labels: ["i18n"], priority: { name: "Lowest" } },
      steps: [
        { action: "Откройте страницу «Профиль»", data: "Имя: Иван_Иванов, путь ~/Library/app_data", result: "Имя показано без искажений: < > & \" '" },
        { action: "Long text " + "lorem ipsum dolor sit amet ".repeat(80), result: "Nothing breaks" },
      ],
    }),
    await test({ summary: "Manual test without steps", type: "Manual", folderPath: "/Mobile", jira: { labels: ["empty"] } }),
  ]);

  log("Cucumber tests");
  const cucumber = present([
    await test({
      summary: "Log out",
      type: "Cucumber",
      folderPath: "/Web/Auth",
      jira: { labels: ["bdd"], priority: { name: "Medium" }, components: [{ name: "Auth" }] },
      gherkin: 'Given I am logged in as "jane"\nWhen I press "Log out"\nThen I see the login page',
    }),
    await test({
      summary: "Search by name",
      type: "Cucumber",
      folderPath: "/Web/Shop",
      jira: { labels: ["bdd", "search"] },
      gherkin: 'Given the catalog has products\nWhen I search for "<query>"\nThen I see <count> results\n\nExamples:\n  | query | count |\n  | phone | 3     |\n  | case  | 5     |',
    }),
  ]);

  log("Generic tests");
  const generic = present([
    await test({
      summary: "Login API contract",
      type: "Generic",
      folderPath: "/API/v2",
      jira: { labels: ["api", "automated"], components: [{ name: "API" }], priority: { name: "High" } },
      unstructured: "com.example.api.LoginContractTest#validCredentials",
    }),
    await test({ summary: "Health check", type: "Generic", folderPath: "/API", unstructured: "GET /health returns *200*" }),
  ]);

  log("Jira content");
  const login = manual[0];
  if (login) {
    await attach(login.key, "login-form.png", PNG, "image/png");
    await attach(login.key, "accounts.csv", CSV, "text/csv");
    await describe(
      login.key,
      "Checks the *login* form with valid data.\n\n!login-form.png|thumbnail!\n\n||Browser||Version||\n|Chrome|latest|\n|Firefox|ESR|\n\n{code:bash}\ncurl -X POST /login\n{code}\n\nSee [the spec|https://wiki.example.com/login].",
      "Staging, Chrome latest",
    );
    await comment(login.key, "Reviewed by *QA lead*, looks good.");
    await comment(login.key, "Second comment with a link to [Jira|https://www.atlassian.com].");
    if (loginStory) await link("Test", login.key, loginStory);
  }
  if (manual[2] && checkoutStory) await link("Test", manual[2].key, checkoutStory);
  if (manual[2] && blocker) await link("Blocks", blocker, manual[2].key);
  if (cucumber[0] && loginStory) await link("Test", cucumber[0].key, loginStory);
  if (manual[1]) await describe(manual[1].key, "h2. Negative case\n\n# Wrong password\n# Locked account\n## After 5 attempts\n\n_Italic_ and -strike- text.");

  log("Test sets and plans");
  const all = [...manual, ...cucumber, ...generic, ...present([openApp, logIn])];
  await testSet("Smoke", present([manual[0] ?? null, cucumber[0] ?? null, generic[1] ?? null]));
  await testSet("Regression", all);
  await testSet("Login", present([manual[0] ?? null, manual[1] ?? null, cucumber[0] ?? null]));
  await testPlan("Release 1.0", present([manual[0] ?? null, manual[1] ?? null]));
  await testPlan("Release 2.0", all);

  log(`Generated tests: ${generated.length} (${SCENARIOS.length} scenarios${bulk > 0 ? ` and ${bulk} variations` : ""})`);
  const calls = { logIn, openApp };
  const made: Created[] = [];
  for (const [index, item] of generated.entries()) {
    const steps = item.steps?.map((step) => ({
      ...(step.action ? { action: step.action } : {}),
      ...(step.data ? { data: step.data } : {}),
      ...(step.result ? { result: step.result } : {}),
      ...(step.file === "png" ? { attachments: [file("screenshot.png", PNG, "image/png")] } : {}),
      ...(step.file === "csv" ? { attachments: [file("test-data.csv", CSV, "text/csv")] } : {}),
    }));
    const call = item.calls ? calls[item.calls] : null;
    const created = await test({
      summary: item.title,
      type: item.type,
      folderPath: item.folder,
      steps: steps ? [...(call ? [{ callTestIssueId: call.issueId }] : []), ...steps] : undefined,
      gherkin: item.gherkin,
      unstructured: item.unstructured,
      preconditions: present((item.preconditions ?? []).map((name) => pool[name])),
      jira: {
        labels: ["generated", ...item.labels, ...(index >= SCENARIOS.length ? ["bulk"] : [])],
        priority: { name: item.priority },
        components: [{ name: item.component }],
        ...(item.fixVersion ? { fixVersions: [{ name: item.fixVersion }] } : {}),
        ...(item.assignToMe ? { assignee: { accountId } } : {}),
      },
    });
    if (created) {
      made.push(created);
    }
  }
  if (made.length > 0) {
    await testSet("Generated scenarios", made);
    await testPlan("Release 2.1", made.filter((_, i) => i % 2 === 0));
  }
  log("Done.");
}

async function cleanup() {
  const jql = `project = "${projectKey}" AND labels = "${LABEL}"`;
  const issues: { id: string; key: string }[] = [];
  for await (const page of jira.search(jql, { fields: ["key"] })) {
    issues.push(...page.map((issue) => ({ id: issue.id, key: issue.key })));
  }
  log(`${issues.length} issue(s) labelled ${LABEL} in ${projectKey}.`);
  if (!flag("yes")) {
    log("Nothing deleted. Run again with --yes to delete them.");
    return;
  }
  for (const issue of issues) {
    await attempt(`delete ${issue.key}`, () => jira.http.json("DELETE", `rest/api/3/issue/${issue.id}`, { query: { deleteSubtasks: true } }));
    log(`  deleted ${issue.key}`);
  }
  log("Done. Empty Xray folders stay; remove them in the Test Repository if needed.");
}

await (flag("cleanup") ? cleanup() : seed());
