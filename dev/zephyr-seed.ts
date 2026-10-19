/**
 * Fills a Jira Cloud project with Zephyr test cases (Zephyr, formerly Zephyr Scale, or Zephyr
 * Essential) that cover everything the migration reads, to try the tool against a real Zephyr.
 * Every created test case and Jira issue gets the label `atm-seed`.
 *
 *   JIRA_URL=https://you.atlassian.net JIRA_EMAIL=you@example.com JIRA_API_TOKEN=... \
 *   ZEPHYR_API_TOKEN=... [ZEPHYR_URL=https://eu.api.zephyrscale.smartbear.com/v2] \
 *   npx tsx dev/zephyr-seed.ts --project ZFMTT [--bulk 300]
 *
 * ZEPHYR_URL is the API address of your Zephyr: the default region, eu., au. or de., or
 * https://prod-api.zephyr4jiracloud.com/v2 for Zephyr Essential. The token is created in Jira under
 * your profile menu, Zephyr API Access Tokens.
 *
 * Besides hand-made edge cases it creates the scenarios of dev/xray-seed-scenarios.ts once each;
 * `--bulk N` adds N more test cases made from variations of them. Manual scenarios get steps,
 * Cucumber scenarios a BDD script, Generic scenarios a plain text script.
 *
 * Custom fields cannot be created through the API. Create these in Zephyr (project settings,
 * Zephyr, Custom fields, Test case) before seeding, to get them filled; without them the test
 * cases are created without custom fields:
 *   Automation    single choice: Manual, Automated, Planned
 *   Reviewed      checkbox
 *   Notes         multi-line text
 *   Browsers      multiple choice: Chrome, Firefox, Safari, Edge
 *   Reviewer      user picker
 *   Release date  date
 *   Story points  number
 * Step custom field (Custom fields, Test step):
 *   Browser       single line text
 *
 * The API cannot delete test cases. `--cleanup` lists the seeded test cases and deletes the Jira
 * stories; delete the test cases in Zephyr (filter by the label atm-seed, select all, delete).
 *
 *   npx tsx dev/zephyr-seed.ts --project ZFMTT --cleanup --yes
 */
import { fetch } from "undici";
import { JiraClient } from "../packages/server/src/jira/client.js";
import { HttpError } from "../packages/server/src/http/httpClient.js";
import { ZephyrClient, failureText, zephyrAddressOfToken } from "../packages/server/src/zephyr/client.js";
import type { ZephyrFolder, ZephyrOption, ZephyrTestCase, ZephyrTestStep } from "../packages/server/src/zephyr/types.js";
import { COMPONENTS, generate, SCENARIOS, type GeneratedTest, type PreconditionName, type StepTemplate } from "./xray-seed-scenarios.js";

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
    fail(`Set the environment variable ${name}. See the top of dev/zephyr-seed.ts.`);
  }
  return value;
};
if (!projectKey) {
  fail("Pass the Jira project key: --project KEY.");
}

const log = (message: string) => console.log(message);
const onRetry = (info: { attempt: number; of: number; reason: string; delayMs: number }) => log(`  retry ${info.attempt}/${info.of} in ${Math.round(info.delayMs / 1000)}s: ${info.reason}`);
const connection = {
  endpoint: env("ZEPHYR_URL", "https://api.zephyrscale.smartbear.com/v2"),
  apiToken: env("ZEPHYR_API_TOKEN"),
  requestsPerMinute: Number(process.env.ZEPHYR_REQUESTS_PER_MINUTE ?? 120),
  jiraUrl: env("JIRA_URL"),
  jiraEmail: env("JIRA_EMAIL"),
  jiraApiToken: env("JIRA_API_TOKEN"),
};
const zephyr = new ZephyrClient(connection, { onRetry });
const jira = new JiraClient(connection, onRetry);

/** Runs a step, reports a failure and goes on: one missing setting should not stop the rest. */
async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log(`  ! ${what}: ${failureText(error)}`);
    return null;
  }
}

// ------------------------------------------------------------------ files and text

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mNk+M+AFTAxkAhGNYxqGNUwqmFUw6iGUQ2jGgYJAAA8TwEQ2XtoNQAAAABJRU5ErkJggg==",
  "base64",
);
const CSV = Buffer.from("login,password\njane,secret\nsam,hunter2\n");

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Inline Jira wiki markup of the shared scenarios as the HTML Zephyr keeps. */
function inline(text: string): string {
  return escape(text)
    .replace(/\{\{([^}]+)\}\}/g, "<code>$1</code>")
    .replace(/\{color:([#\w]+)\}([\s\S]*?)\{color\}/g, '<span style="color:$1">$2</span>')
    .replace(/\[([^|\]]+)\|(https?:\/\/[^\]]+)\]/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<strong>$2</strong>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])-([^-\n]+)-(?=[\s.,)]|$)/g, "$1<s>$2</s>");
}

/** Jira wiki markup (paragraphs, lists, tables, code) to HTML. */
function html(wiki: string | undefined): string | null {
  if (!wiki?.trim()) {
    return null;
  }
  const out: string[] = [];
  const lines = wiki.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\{code(:\w+)?\}/.test(line)) {
      const code: string[] = [];
      for (i++; i < lines.length && !/^\{code\}/.test(lines[i]!); i++) {
        code.push(lines[i]!);
      }
      out.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
    } else if (/^\|/.test(line)) {
      const rows: string[] = [];
      for (; i < lines.length && /^\|/.test(lines[i]!); i++) {
        const row = lines[i]!;
        const header = row.startsWith("||");
        const cells = row.split(header ? "||" : "|").slice(1, -1);
        rows.push(`<tr>${cells.map((cell) => (header ? `<th>${inline(cell)}</th>` : `<td>${inline(cell)}</td>`)).join("")}</tr>`);
      }
      i--;
      out.push(`<table><tbody>${rows.join("")}</tbody></table>`);
    } else if (/^[*#]\s/.test(line)) {
      const ordered = line.startsWith("#");
      const items: string[] = [];
      for (; i < lines.length && /^[*#]\s/.test(lines[i]!); i++) {
        items.push(`<li>${inline(lines[i]!.slice(2))}</li>`);
      }
      i--;
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (/^h(\d)\.\s/.test(line)) {
      out.push(`<h${line[1]}>${inline(line.slice(4))}</h${line[1]}>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  return out.join("");
}

// ------------------------------------------------------------------ Zephyr and Jira

let accountId = "";
let customFields = true;
let stepCustomFields = true;
const priorities = new Map<string, string>();
const components = new Map<string, number>();
const folderIds = new Map<string, number>();

async function prepareProject() {
  const project = await zephyr.project(projectKey!).catch(async (error: unknown) => {
    const address = error instanceof HttpError && error.status === 401 ? await zephyrAddressOfToken(connection.apiToken, connection.endpoint) : null;
    return fail(
      `Zephyr has no project ${projectKey}, or the token cannot read it: ${failureText(error)}` +
        (address ? `\nThe token works with ${address}: set ZEPHYR_URL=${address} and run again.` : error instanceof HttpError && error.status === 401 ? "\nNo known Zephyr address accepts the token: check that the whole token was copied and that it belongs to this Jira site." : ""),
    );
  });
  accountId = (await jira.myself()).accountId;
  log(`Project ${project.key} (Zephyr id ${project.id}).`);
  for (const name of COMPONENTS) {
    await attempt(`component ${name}`, () => jira.http.json("POST", "rest/api/3/component", { body: { name, project: projectKey } }));
  }
  for (const component of await jira.components(projectKey!)) {
    components.set(component.name, Number(component.id));
  }
  const known: ZephyrOption[] = await zephyr.priorities(projectKey!);
  // Jira priorities of the scenarios to the default Zephyr ones.
  const wanted: Record<string, string> = { Highest: "High", High: "High", Medium: "Normal", Low: "Low", Lowest: "Low" };
  for (const [jiraName, zephyrName] of Object.entries(wanted)) {
    const found = known.find((p) => p.name.toLowerCase() === zephyrName.toLowerCase()) ?? known.find((p) => p.default);
    if (found) {
      priorities.set(jiraName, found.name);
    }
  }
  const statuses = await zephyr.statuses(projectKey!);
  if (!statuses.some((status) => status.name === "In review")) {
    await attempt("status In review", () => zephyr.http.json("POST", "statuses", { body: { projectKey, name: "In review", type: "TEST_CASE", color: "#4c9aff" } }));
  }
  const folders = await zephyr.folders(projectKey!);
  for (const folder of folders) {
    folderIds.set(pathOf(folder, folders), folder.id);
  }
}

function pathOf(folder: ZephyrFolder, all: ZephyrFolder[]): string {
  const parts: string[] = [];
  for (let current: ZephyrFolder | undefined = folder; current; current = all.find((f) => f.id === current!.parentId)) {
    parts.unshift(current.name);
  }
  return `/${parts.join("/")}`;
}

/** The folder of a path, created with its parents when missing. */
async function folder(path: string): Promise<number | null> {
  const parts = path.split("/").filter(Boolean);
  let parentId: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    const current = `/${parts.slice(0, i + 1).join("/")}`;
    let id = folderIds.get(current);
    if (!id) {
      const created = await attempt(`folder ${current}`, () =>
        zephyr.http.json<{ id: number }>("POST", "folders", { body: { projectKey, name: parts[i], folderType: "TEST_CASE", ...(parentId ? { parentId } : {}) } }),
      );
      if (!created) {
        return parentId;
      }
      id = created.id;
      folderIds.set(current, id);
    }
    parentId = id;
  }
  return parentId;
}

async function story(summary: string): Promise<{ id: number; key: string } | null> {
  const created = await attempt(`story "${summary}"`, () =>
    jira.http.json<{ id: string; key: string }>("POST", "rest/api/3/issue", { body: { fields: { project: { key: projectKey }, issuetype: { name: "Story" }, summary, labels: [LABEL] } } }),
  );
  return created ? { id: Number(created.id), key: created.key } : null;
}

/** Uploads a file to a test case or one of its steps; the API takes the raw bytes. */
async function upload(key: string, stepId: number | null, name: string, data: Buffer, type: string) {
  await attempt(`file ${name} on ${key}${stepId ? ` step ${stepId}` : ""}`, async () => {
    const url = zephyr.http.url(`testcases/${key}${stepId ? `/teststeps/${stepId}` : ""}/attachments/${encodeURIComponent(name)}`);
    const response = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${connection.apiToken}`, "Content-Type": type }, body: data });
    if (!response.ok) {
      throw new Error(`status ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  });
}

interface CaseInput {
  name: string;
  folder?: string;
  objective?: string | null;
  precondition?: string | null;
  labels?: string[];
  priority?: string;
  status?: string;
  component?: string;
  owner?: boolean;
  estimatedMinutes?: number;
  fields?: Record<string, unknown>;
  steps?: ({ inline: { description?: string | null; testData?: string | null; expectedResult?: string | null; customFields?: Record<string, unknown> }; file?: "png" | "csv" } | { testCase: { testCaseKey: string; parameters?: { name: string; type: string; value: string }[] } })[];
  script?: { type: "plain" | "bdd"; text: string };
  issues?: ({ id: number; key: string } | null)[];
  webLinks?: { url: string; description: string }[];
  files?: ("png" | "csv")[];
}

/** Creates a test case with its steps or script, links and files. */
async function testCase(input: CaseInput): Promise<string | null> {
  const folderId = input.folder ? await folder(input.folder) : null;
  const body = {
    projectKey,
    name: input.name,
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.precondition ? { precondition: input.precondition } : {}),
    labels: [LABEL, ...(input.labels ?? [])],
    ...(input.priority && priorities.get(input.priority) ? { priorityName: priorities.get(input.priority) } : {}),
    ...(input.status ? { statusName: input.status } : {}),
    ...(input.component && components.get(input.component) ? { componentId: components.get(input.component) } : {}),
    ...(input.owner ? { ownerId: accountId } : {}),
    ...(input.estimatedMinutes ? { estimatedTime: input.estimatedMinutes * 60_000 } : {}),
    ...(folderId ? { folderId } : {}),
  };
  const create = (withFields: boolean) => zephyr.http.json<{ id: number; key: string }>("POST", "testcases", { body: withFields && input.fields ? { ...body, customFields: input.fields } : body });
  let created = await attempt(`test case "${input.name}"`, () => create(customFields));
  if (!created && customFields && input.fields) {
    // Most likely a custom field the project does not have: go on without them.
    customFields = false;
    log("  Custom fields are left out from now on. Create them in Zephyr as listed at the top of dev/zephyr-seed.ts to get them filled.");
    created = await attempt(`test case "${input.name}" without custom fields`, () => create(false));
  }
  if (!created) {
    return null;
  }
  const key = created.key;
  log(`  ${key}: ${input.name}`);
  if (input.script) {
    const saved = await attempt(`script of ${key}`, () => zephyr.http.json("POST", `testcases/${key}/testscript`, { body: input.script }));
    // A second scenario in one script (shared with the Xray seed) is not valid Gherkin for Zephyr.
    const steps = input.script.text.split(/\n\s*(?:Feature|Scenario(?: Outline)?):.*\n/)[0]!;
    if (saved === null && input.script.type === "bdd" && steps !== input.script.text) {
      await attempt(`script of ${key} with the first scenario only`, () => zephyr.http.json("POST", `testcases/${key}/testscript`, { body: { ...input.script, text: steps } }));
    }
  }
  if (input.steps?.length) {
    const items = input.steps.map((step) =>
      "inline" in step ? { inline: { ...step.inline, customFields: stepCustomFields ? (step.inline.customFields ?? {}) : {} } } : { testCase: step.testCase },
    );
    let saved = await attempt(`steps of ${key}`, () => zephyr.http.json("POST", `testcases/${key}/teststeps`, { body: { mode: "OVERWRITE", items } }));
    if (!saved) {
      // A called test case without those parameters, or a step custom field the project does not have.
      stepCustomFields = false;
      const plainItems = input.steps.map((step) => ("inline" in step ? { inline: { ...step.inline, customFields: {} } } : { testCase: { testCaseKey: step.testCase.testCaseKey } }));
      saved = await attempt(`steps of ${key} without parameters and step custom fields`, () => zephyr.http.json("POST", `testcases/${key}/teststeps`, { body: { mode: "OVERWRITE", items: plainItems } }));
      if (saved) {
        log("  Saved without call parameters and step custom fields. Declare the parameters in the called test case (Test Script, Parameters) and the step field Browser to try them.");
      }
    }
    if (saved && input.steps.some((step) => "file" in step && step.file)) {
      const stored: ZephyrTestStep[] = (await attempt(`steps of ${key}`, () => zephyr.testSteps(key))) ?? [];
      for (const [index, step] of input.steps.entries()) {
        const stepId = stored[index]?.id;
        if ("file" in step && step.file && stepId) {
          await upload(key, stepId, step.file === "png" ? "screenshot.png" : "test-data.csv", step.file === "png" ? PNG : CSV, step.file === "png" ? "image/png" : "text/csv");
        }
      }
    }
  }
  for (const issue of input.issues ?? []) {
    if (issue) {
      await attempt(`link ${key} to ${issue.key}`, () => zephyr.http.json("POST", `testcases/${key}/links/issues`, { body: { issueId: issue.id } }));
    }
  }
  for (const link of input.webLinks ?? []) {
    await attempt(`web link on ${key}`, () => zephyr.http.json("POST", `testcases/${key}/links/weblinks`, { body: link }));
  }
  for (const kind of input.files ?? []) {
    await upload(key, null, kind === "png" ? "diagram.png" : "accounts.csv", kind === "png" ? PNG : CSV, kind === "png" ? "image/png" : "text/csv");
  }
  return key;
}

const PRECONDITIONS: Record<PreconditionName, string> = {
  user: "<p><strong>User</strong> <code>jane@example.com</code> exists and is <strong>active</strong>.</p><ul><li>role: customer</li><li>password: see the test data</li></ul>",
  admin: "<p>User <code>admin@example.com</code> has the <strong>Administrator</strong> role.</p>",
  cart: "<p>The cart holds:</p><table><tbody><tr><th>Item</th><th>Qty</th></tr><tr><td>Phone</td><td>1</td></tr><tr><td>Case</td><td>2</td></tr></tbody></table>",
  sandbox: '<p>Check <a href="https://status.example.com">the status page</a> first.</p>',
  device: "<p>An iPhone 15 with iOS 18 and a Pixel 8 with Android 15, latest test builds.</p>",
  emptyDb: "<p>Run <code>make reset-db</code> on the test environment.</p>",
};

const stepOf = (step: StepTemplate) => ({ inline: { description: html(step.action), testData: html(step.data), expectedResult: html(step.result) }, ...(step.file ? { file: step.file } : {}) });

// ------------------------------------------------------------------ the data set

async function seed() {
  await prepareProject();

  log("Requirements");
  const loginStory = await story("Users can log in with email and password");
  const checkoutStory = await story("Customers can pay by card");
  const blocker = await story("Payment provider sandbox is available");

  log("Called test cases");
  const openApp = await testCase({
    name: "Open the app and accept cookies",
    folder: "/Common",
    steps: [
      { inline: { description: "<p>Start the app</p>", expectedResult: "<p>The start page is shown</p>" } },
      { inline: { description: "<p>Accept <strong>all</strong> cookies</p>", expectedResult: "<p>The banner disappears</p>" } },
    ],
  });
  const logIn = await testCase({
    name: "Log in as a test user",
    folder: "/Common",
    objective: "<p>Called by other test cases. The parameter <code>user</code> chooses the account.</p>",
    steps: [
      { inline: { description: "<p>Open the login page</p>", expectedResult: "<p>The form is shown</p>" } },
      { inline: { description: "<p>Log in as {user}</p>", testData: "<p>password from the vault</p>", expectedResult: "<p>The dashboard of {user} opens</p>" } },
    ],
  });
  // A call inside a call.
  const logInAndOpen = await testCase({
    name: "Log in and open the app",
    folder: "/Common",
    steps: [...(openApp ? [{ testCase: { testCaseKey: openApp } }] : []), ...(logIn ? [{ testCase: { testCaseKey: logIn, parameters: [{ name: "user", type: "DEFAULT_VALUE", value: "jane" }] } }] : [])],
  });

  log("Hand-made edge cases");
  await testCase({
    name: "Every attribute filled in",
    folder: "/Web/Auth/Login/Errors",
    objective:
      '<p>Checks the <strong>login</strong> form with <em>valid</em> data.</p><table><tbody><tr><th>Browser</th><th>Version</th></tr><tr><td>Chrome</td><td>latest</td></tr><tr><td>Firefox</td><td>ESR</td></tr></tbody></table><pre><code>curl -X POST /login</code></pre><p>See <a href="https://wiki.example.com/login">the spec</a>.</p>',
    precondition: PRECONDITIONS.user,
    labels: ["smoke", "login", "every-attribute"],
    priority: "High",
    status: "In review",
    component: "Auth",
    owner: true,
    estimatedMinutes: 95,
    fields: { Automation: "Automated", Reviewed: true, Notes: "<p>First line<br>Second line</p>", Browsers: ["Chrome", "Firefox"], Reviewer: accountId, "Release date": "2026-05-01", "Story points": 3 },
    steps: [
      { inline: { description: "<p>Open the <em>login</em> page</p>", testData: "<p>url: <code>/login</code></p>", expectedResult: "<p>The form is shown</p>", customFields: { Browser: "Chrome" } }, file: "png" },
      { inline: { description: "<p>Enter the user and the password</p>", testData: "<table><tbody><tr><th>Login</th><th>Password</th></tr><tr><td>jane</td><td>secret</td></tr></tbody></table>", expectedResult: "<ul><li>the dashboard opens</li><li>the name is shown</li></ul>" }, file: "csv" },
      { inline: { description: null, testData: "<p>Only test data, no action</p>", expectedResult: null } },
      { inline: { description: null, testData: null, expectedResult: "<p>Only an expected result</p>" } },
    ],
    issues: [loginStory, blocker],
    webLinks: [{ url: "https://wiki.example.com/login", description: "Login spec" }],
    files: ["png", "csv"],
  });
  await testCase({ name: "Empty test case without steps or script", folder: "/Common", status: "Draft" });
  await testCase({
    name: "Calls with and without parameters",
    folder: "/Web/Shop/Checkout",
    labels: ["calls"],
    steps: [
      ...(logInAndOpen ? [{ testCase: { testCaseKey: logInAndOpen } }] : []),
      ...(logIn ? [{ testCase: { testCaseKey: logIn, parameters: [{ name: "user", type: "MANUAL_INPUT", value: "sam" }] } }] : []),
      { inline: { description: "<p>Pay for the cart</p>", expectedResult: "<p>The order number is shown</p>" } },
    ],
    issues: [checkoutStory],
  });
  await testCase({
    name: "Scenario outline with examples",
    folder: "/Web/Shop/Checkout",
    labels: ["bdd"],
    script: {
      type: "bdd",
      // Zephyr keeps the steps only: a script with Feature or Scenario lines is "Invalid Gherkin script".
      text: "# comment line\nGiven a cart of <total>\nWhen I apply <code>\nThen I pay <price>\n\nExamples:\n  | total | code   | price |\n  | 100   | TEN    | 90    |\n  | 50    | HALF   | 25    |",
    },
  });
  await testCase({
    name: "Plain text script with a numbered list",
    folder: "/API/v2",
    script: { type: "plain", text: "<ol><li>Send <code>GET /health</code></li><li>Check the answer is <strong>200</strong></li></ol><p>3. A line numbered by hand</p>" },
  });
  await testCase({ name: "Deprecated test case", folder: "/Mobile", status: "Deprecated", priority: "Low", steps: [{ inline: { description: "<p>Old flow</p>" } }] });
  await testCase({ name: `Long name ${"x".repeat(200)} end`.slice(0, 255), folder: "/Common" });
  await testCase({ name: "Кириллица и символы <tag> & \"кавычки\"", folder: "/Mobile/iOS/Settings/Privacy/Tracking", steps: [{ inline: { description: "<p>Шаг на русском</p>", expectedResult: "<p>Ожидаемый результат</p>" } }] });

  const generated: GeneratedTest[] = generate(SCENARIOS.length + bulk);
  log(`Generated test cases: ${generated.length} (${SCENARIOS.length} scenarios${bulk > 0 ? ` and ${bulk} variations` : ""})`);
  const calls: Record<string, string | null> = { logIn, openApp };
  for (const [index, item] of generated.entries()) {
    const call = item.calls ? calls[item.calls] : null;
    await testCase({
      name: item.title,
      folder: item.folder,
      objective: `<p>${item.type} scenario of the ${item.component} area.</p>`,
      precondition: item.preconditions?.map((name) => PRECONDITIONS[name]).join("") || null,
      labels: ["generated", ...item.labels, ...(index >= SCENARIOS.length ? ["bulk"] : [])],
      priority: item.priority,
      status: index % 7 === 0 ? "Draft" : "Approved",
      component: item.component,
      owner: item.assignToMe,
      fields: { Automation: item.type === "Manual" ? "Manual" : "Automated", ...(index % 3 === 0 ? { Browsers: ["Chrome"] } : {}) },
      steps: item.steps
        ? [...(call ? [{ testCase: { testCaseKey: call, ...(item.calls === "logIn" ? { parameters: [{ name: "user", type: "MANUAL_INPUT", value: "jane" }] } : {}) } }] : []), ...item.steps.map(stepOf)]
        : undefined,
      script: item.gherkin ? { type: "bdd", text: item.gherkin } : item.unstructured ? { type: "plain", text: html(item.unstructured) ?? item.unstructured } : undefined,
      issues: index % 5 === 0 ? [index % 2 === 0 ? loginStory : checkoutStory] : [],
    });
  }
  log("Done. To check pictures in text, paste an image into the objective and into a step of one test case in Zephyr: the API cannot put one there.");
}

async function cleanup() {
  const seeded: ZephyrTestCase[] = [];
  for await (const page of zephyr.testCases(projectKey!)) {
    seeded.push(...page.filter((testCase) => testCase.labels?.includes(LABEL)));
  }
  log(`${seeded.length} test case(s) labelled ${LABEL} in ${projectKey}. The Zephyr API cannot delete them: in Zephyr, filter the test cases by the label ${LABEL}, select all and delete.`);
  const issues: { id: string; key: string }[] = [];
  for await (const page of jira.search(`project = "${projectKey}" AND labels = "${LABEL}"`, { fields: ["key"] })) {
    issues.push(...page.map((issue) => ({ id: issue.id, key: issue.key })));
  }
  log(`${issues.length} Jira issue(s) labelled ${LABEL}.`);
  if (!flag("yes")) {
    log("Nothing deleted. Run again with --yes to delete the Jira issues.");
    return;
  }
  for (const issue of issues) {
    await attempt(`delete ${issue.key}`, () => jira.http.json("DELETE", `rest/api/3/issue/${issue.id}`));
    log(`  deleted ${issue.key}`);
  }
  log("Done.");
}

await (flag("cleanup") ? cleanup() : seed());
