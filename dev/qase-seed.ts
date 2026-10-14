/**
 * Fills a Qase project with test cases that cover everything the migration reads, to try the tool
 * against a real Qase workspace. Everything it creates is named or marked so it can be removed again.
 *
 *   QASE_API_TOKEN=... [QASE_URL=https://api.qase.io] npx tsx dev/qase-seed.ts --project DEMO [--bulk 300]
 *
 * It creates suites three levels deep, custom fields of every type (their titles start with "ATM"),
 * milestones, shared steps, attachments and cases: classic steps with data, expected results, nested
 * steps, files and shared steps, Gherkin cases, cases without steps, parameters, tags and every
 * system field. The scenarios of dev/xray-seed-scenarios.ts are created once each; `--bulk N` adds N
 * more made from variations of them. Running it again adds only what is missing.
 *
 *   --create     create the project when it does not exist
 *   --dry        show what would be created, without writing
 *
 *   npx tsx dev/qase-seed.ts --project DEMO --cleanup --yes            # removes the seeded suites, cases, shared steps and milestones
 *   npx tsx dev/qase-seed.ts --project DEMO --cleanup --fields --yes   # also deletes the "ATM" custom fields of the workspace
 */
import { HttpError } from "../packages/server/src/http/httpClient.js";
import { QaseClient } from "../packages/server/src/qase/client.js";
import type { QaseCase, QaseCustomField, QaseMilestone, QaseSharedStep, QaseSuite } from "../packages/server/src/qase/types.js";
import { wikiToMarkdown } from "../packages/server/src/xray/wiki.js";
import { folderPaths, generate, random, SCENARIOS, VERSIONS, type GeneratedTest, type StepTemplate } from "./xray-seed-scenarios.js";

/** In the description of every seeded suite: what cleanup looks for. */
const MARKER = "Created by dev/qase-seed.ts";
const PREFIX = "ATM";
const TAG = "atm-seed";

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

const code = option("project")?.toUpperCase();
const bulk = Number(option("bulk") ?? 0);
const dry = flag("dry");
if (!code) {
  fail("Pass the Qase project code: --project CODE.");
}
const token = process.env.QASE_API_TOKEN;
if (!token) {
  fail(
    "The environment variable QASE_API_TOKEN is not set for this script. Run: export QASE_API_TOKEN=<token>. A variable set without export is shown by echo but not passed to programs started from the shell.",
  );
}

const log = (message: string) => console.log(message);
const qase = new QaseClient(
  { endpoint: process.env.QASE_URL ?? "https://api.qase.io", apiToken: token, appUrl: "", rateLimit: "free", insecureTls: false },
  (info) => log(`  waiting ${Math.round(info.delayMs / 1000)} s: ${info.reason}`),
);

/** Runs a step, reports a failure and goes on: one missing permission or plan limit should not stop the rest. */
async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log(`  ! ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function write<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  if (dry) {
    log(`  would create ${what}`);
    return null;
  }
  return attempt(what, run);
}

// ------------------------------------------------------------------ files

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mNk+M+AFTAxkAhGNYxqGNUwqmFUw6iGUQ2jGgYJAAA8TwEQ2XtoNQAAAABJRU5ErkJggg==",
  "base64",
);
const CSV = Buffer.from("login,password\njane,secret\nsam,hunter2\n");

interface Uploaded {
  hash: string;
  url: string;
}
const files: { png: Uploaded | null; csv: Uploaded | null } = { png: null, csv: null };

async function uploadFiles() {
  const upload = (name: string, data: Buffer, contentType: string) =>
    write(`attachment ${name}`, async () => {
      const answer = await qase.http.upload<{ result: { hash: string; url: string }[] }>(`attachment/${code}`, {}, [{ field: "file[]", name, data, contentType }]);
      const file = answer?.result?.[0];
      if (!file?.hash) {
        throw new Error(`unexpected answer ${JSON.stringify(answer).slice(0, 200)}`);
      }
      return { hash: file.hash, url: file.url };
    });
  files.png = await upload("screenshot.png", PNG, "image/png");
  files.csv = await upload("test-data.csv", CSV, "text/csv");
  if (files.png) {
    log(`Uploaded 2 attachments. Addresses look like ${files.png.url}`);
  }
}

// ------------------------------------------------------------------ custom fields

/** Type codes of the Qase API. */
const TYPE = { number: 0, string: 1, text: 2, selectbox: 3, checkbox: 4, radio: 5, multiselect: 6, url: 7, user: 8, datetime: 9 } as const;

const FIELDS: { title: string; type: keyof typeof TYPE; options?: string[] }[] = [
  { title: `${PREFIX} Browser`, type: "selectbox", options: ["Chrome", "Firefox", "Safari", "Edge"] },
  { title: `${PREFIX} Platforms`, type: "multiselect", options: ["Web", "iOS", "Android", "API"] },
  { title: `${PREFIX} Risk`, type: "radio", options: ["Low", "Medium", "High"] },
  { title: `${PREFIX} Reviewer`, type: "user" },
  { title: `${PREFIX} Flaky`, type: "checkbox" },
  { title: `${PREFIX} Build`, type: "string" },
  { title: `${PREFIX} Estimate`, type: "number" },
  { title: `${PREFIX} Notes`, type: "text" },
  { title: `${PREFIX} Spec`, type: "url" },
  { title: `${PREFIX} Reviewed on`, type: "datetime" },
];

const fieldIds = new Map<string, number>();
const optionIds = new Map<string, Map<string, number>>();

function readOptions(field: QaseCustomField): Map<string, number> {
  try {
    return new Map((JSON.parse(field.value ?? "[]") as { id: number; title: string }[]).map((option) => [option.title, option.id]));
  } catch {
    return new Map();
  }
}

async function prepareFields() {
  const existing = await qase.customFields();
  for (const field of FIELDS) {
    let found = existing.find((f) => f.title === field.title);
    if (found && !found.is_enabled_for_all_projects && !found.projects_codes?.includes(code!)) {
      // Made for another project: enable it here too.
      await write(`custom field "${field.title}" in project ${code}`, () =>
        qase.send("PATCH", `custom_field/${found!.id}`, {
          title: found!.title,
          value: found!.value ? JSON.parse(found!.value) : undefined,
          is_enabled_for_all_projects: false,
          projects_codes: [...(found!.projects_codes ?? []), code],
        }),
      );
    }
    if (!found) {
      const created = await write(`custom field "${field.title}" (${field.type})`, () =>
        qase.send<{ id: number }>("POST", "custom_field", {
          title: field.title,
          entity: 0,
          type: TYPE[field.type],
          value: field.options?.map((title, index) => ({ id: index + 1, title })),
          is_filterable: true,
          is_visible: true,
          is_required: false,
          is_enabled_for_all_projects: false,
          projects_codes: [code],
        }),
      );
      if (created) {
        found = { id: created.id, title: field.title, entity: "case", type: field.type, value: JSON.stringify(field.options?.map((title, index) => ({ id: index + 1, title })) ?? []) };
      }
    }
    if (found) {
      fieldIds.set(field.title, found.id);
      optionIds.set(field.title, readOptions(found));
    }
  }
  log(`Custom fields: ${fieldIds.size} of ${FIELDS.length} ready.`);
}

// ------------------------------------------------------------------ milestones, suites, shared steps

const milestoneIds = new Map<string, number>();

async function prepareMilestones() {
  const existing = await qase.milestones(code!);
  for (const version of VERSIONS) {
    const title = `${PREFIX} Release ${version}`;
    const found = existing.find((m) => m.title === title);
    const id = found?.id ?? (await write(`milestone "${title}"`, () => qase.send<{ id: number }>("POST", `milestone/${code}`, { title, description: MARKER })))?.id;
    if (id) {
      milestoneIds.set(version, id);
    }
  }
}

/** Folder path, e.g. `/Web/Auth/Password`, to suite id. */
const suiteIds = new Map<string, number>();

async function prepareSuites(tests: GeneratedTest[]) {
  const existing = await qase.suites(code!);
  let created = 0;
  for (const path of folderPaths(tests)) {
    const parts = path.split("/").filter(Boolean);
    const title = parts[parts.length - 1]!;
    const parent = parts.length > 1 ? (suiteIds.get(`/${parts.slice(0, -1).join("/")}`) ?? null) : null;
    const found = existing.find((s) => s.title === title && (s.parent_id ?? null) === parent && (s.description ?? "").includes(MARKER));
    let id = found?.id;
    if (!id) {
      const depth = parts.length;
      id = (
        await write(`suite ${path}`, () =>
          qase.send<{ id: number }>("POST", `suite/${code}`, {
            title,
            description: depth === 1 ? `Everything about **${title}**.\n\n${MARKER}` : MARKER,
            preconditions: depth === 2 ? `The test environment for ${title} is up.` : undefined,
            parent_id: parent ?? undefined,
          }),
        )
      )?.id;
      created += id ? 1 : 0;
    }
    if (id) {
      suiteIds.set(path, id);
    }
  }
  log(`Suites: ${suiteIds.size} ready, ${created} created.`);
}

const sharedHashes = new Map<"logIn" | "openApp", string>();

const SHARED: Record<"logIn" | "openApp", { title: string; steps: unknown[] }> = {
  logIn: {
    title: `${PREFIX} Log in as a customer`,
    steps: [
      { action: "Open the login page", expected_result: "The form is shown", data: "URL: /login" },
      { action: "Enter the credentials", expected_result: "The dashboard opens", steps: [{ action: "Type the email" }, { action: "Type the password" }] },
    ],
  },
  openApp: {
    title: `${PREFIX} Open the mobile app`,
    steps: [{ action: "Install the latest build from the store" }, { action: "Open the app and skip the tour", expected_result: "The home screen is shown" }],
  },
};

async function prepareSharedSteps() {
  const existing = await qase.sharedSteps(code!);
  for (const key of ["logIn", "openApp"] as const) {
    const found = existing.find((s) => s.title === SHARED[key].title);
    const hash = found?.hash ?? (await write(`shared step "${SHARED[key].title}"`, () => qase.send<{ hash: string }>("POST", `shared_step/${code}`, SHARED[key])))?.hash;
    if (hash) {
      sharedHashes.set(key, hash);
    }
  }
  log(`Shared steps: ${sharedHashes.size} ready.`);
}

// ------------------------------------------------------------------ cases

const markdown = (text: string | undefined) => (text ? wikiToMarkdown(text) : undefined);

const PRECONDITIONS: Record<string, string> = {
  user: "A registered customer `jane@example.com` exists.",
  admin: "An administrator account exists.",
  cart: "The cart holds at least one product.",
  sandbox: "The payment sandbox is reachable.",
  device: "A phone with the app installed.",
  emptyDb: "The database is empty.",
};

function classicStep(step: StepTemplate) {
  const file = step.file === "png" ? files.png : step.file === "csv" ? files.csv : null;
  return {
    action: markdown(step.action) ?? "Check the result",
    expected_result: markdown(step.result),
    data: markdown(step.data),
    attachments: file ? [file.hash] : undefined,
  };
}

/**
 * Gherkin that the Qase API accepts: it answers 500 to Feature and Scenario lines (the case title
 * says it) and to doc strings, whose content goes to the end of the step before them.
 */
export function qaseGherkin(gherkin: string): string {
  return gherkin
    .replace(/^\s*(Feature|Scenario( Outline)?|Background):.*$/gm, "")
    .replace(/:?\s*\n\s*("""|```)[^\n]*\n([\s\S]*?)\n\s*\1[^\n]*/g, (_match, _fence: string, content: string) => ` ${content.replace(/\s*\n\s*/g, " ").trim()}`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A Qase case from a generated test. `index` drives the variety, so reruns give the same cases. */
function caseBody(test: GeneratedTest, index: number, userId: number | null) {
  const rnd = random(index + 1000);
  const option = (field: string, title: string) => optionIds.get(`${PREFIX} ${field}`)?.get(title);
  const id = (field: string) => fieldIds.get(`${PREFIX} ${field}`);
  const custom: Record<string, string> = {};
  const set = (field: string, value: string | number | undefined) => {
    if (id(field) && value !== undefined && value !== "") {
      custom[String(id(field))] = String(value);
    }
  };
  if (rnd.chance(0.7)) set("Browser", option("Browser", rnd.pick(["Chrome", "Firefox", "Safari", "Edge"])));
  if (rnd.chance(0.6)) {
    const platforms = ["Web", "iOS", "Android", "API"].filter(() => rnd.chance(0.45));
    set("Platforms", platforms.map((p) => option("Platforms", p)).filter(Boolean).join(","));
  }
  if (rnd.chance(0.5)) set("Risk", option("Risk", rnd.pick(["Low", "Medium", "High"])));
  if (rnd.chance(0.3) && userId) set("Reviewer", userId);
  if (rnd.chance(0.2)) set("Flaky", "1");
  if (rnd.chance(0.5)) set("Build", `build-${100 + (index % 40)}`);
  if (rnd.chance(0.4)) set("Estimate", rnd.pick([5, 10, 15, 30, 60]));
  if (rnd.chance(0.3)) set("Notes", "Review after the **checkout** redesign.\n\n- check the copy\n- check the layout");
  if (rnd.chance(0.3)) set("Spec", `https://docs.example.com/specs/${test.component.toLowerCase()}`);
  if (rnd.chance(0.3)) set("Reviewed on", `2026-0${1 + (index % 9)}-15T10:00:00+00:00`);

  const labels = test.labels;
  const type = labels.includes("smoke") ? 2 : labels.includes("security") ? 4 : labels.includes("regression") ? 3 : rnd.pick([1, 8, 8, 8, 5, 6, 7, 9, 10, 11]);
  const priority = { Highest: 1, High: 1, Medium: 2, Low: 3, Lowest: 3 }[test.priority] ?? 0;
  const automated = test.type !== "Manual" || rnd.chance(0.1);

  const description = [
    `Covers **${test.component}**: ${test.title.toLowerCase()}.`,
    rnd.chance(0.25) ? "| Environment | Value |\n| --- | --- |\n| Stage | https://stage.example.com |\n| Data set | users-1 |" : "",
    rnd.chance(0.2) && files.png ? `How it looks:\n\n![screenshot](${files.png.url})` : "",
    test.type === "Generic" && test.unstructured ? `Definition:\n\n\`\`\`\n${test.unstructured}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  let steps: unknown[] | undefined;
  let stepsType: "classic" | "gherkin" = "classic";
  if (test.type === "Cucumber" && test.gherkin) {
    stepsType = "gherkin";
    steps = [{ value: qaseGherkin(test.gherkin) }];
  } else if (test.steps?.length) {
    const classic = test.steps.map(classicStep);
    // Every sixth case: the steps after the first one are nested under it, two levels deep.
    const nested = index % 6 === 5 && classic.length >= 3 ? [{ ...classic[0]!, steps: [{ ...classic[1]!, steps: classic.slice(2, 3) }, ...classic.slice(3)] }] : classic;
    const shared = test.calls ? sharedHashes.get(test.calls) : undefined;
    steps = [...(shared ? [{ shared }] : []), ...nested];
  }

  const parameters =
    index % 7 === 3
      ? [{ title: "browser", values: ["chrome", "firefox", "safari"] }]
      : index % 11 === 4
        ? [{ items: [{ title: "user", values: ["admin", "guest"] }, { title: "locale", values: ["en", "de"] }] }, { title: "plan", values: ["free", "pro"] }]
        : undefined;

  return {
    title: test.title.slice(0, 255),
    description,
    preconditions: test.preconditions?.map((name) => `- ${PRECONDITIONS[name] ?? name}`).join("\n"),
    postconditions: rnd.chance(0.15) ? "Remove the data created by the test." : undefined,
    severity: rnd.pick([0, 1, 2, 3, 4, 4, 4, 5, 6]),
    priority,
    type,
    layer: test.component === "API" ? 2 : rnd.pick([0, 1, 1, 1, 3]),
    behavior: labels.includes("negative") ? 3 : rnd.pick([1, 2, 2, 2, 4]),
    is_flaky: rnd.chance(0.1) ? 1 : 0,
    status: rnd.pick([0, 0, 0, 0, 0, 1, 1, 2]),
    // 1 is manual, 0 automated.
    isManual: automated ? 0 : 1,
    isToBeAutomated: !automated && rnd.chance(0.3) ? 1 : 0,
    suite_id: suiteIds.get(test.folder),
    milestone_id: test.fixVersion ? milestoneIds.get(test.fixVersion) : undefined,
    tags: [TAG, ...labels],
    attachments: index % 9 === 2 && files.csv ? [files.csv.hash] : undefined,
    steps_type: stepsType,
    steps,
    parameters,
    custom_field: Object.keys(custom).length > 0 ? custom : undefined,
  };
}

/** Cases that scenarios do not produce: the edges of what Qase accepts. */
function edgeCases(): Record<string, unknown>[] {
  const root = suiteIds.get(folderPaths(generate(1))[0] ?? "");
  return [
    { title: `${PREFIX} edge: no suite, no steps, nothing else`, tags: [TAG] },
    { title: `${PREFIX} edge: special characters <b>&amp; "quotes" 'single' / \\ | * _ # 日本語 🙂`, suite_id: root, tags: [TAG, "edge"], description: "Characters that need escaping: < > & \" ' | * _ # [ ] ( )" },
    { title: `${PREFIX} edge: ${"a very long title ".repeat(13)}`.slice(0, 255), suite_id: root, tags: [TAG, "edge"] },
    {
      title: `${PREFIX} edge: steps three levels deep`,
      suite_id: root,
      tags: [TAG, "edge"],
      steps: [
        {
          action: "Level 1",
          expected_result: "Result of level 1",
          steps: [{ action: "Level 2", data: "Data of level 2", steps: [{ action: "Level 3", expected_result: "Result of level 3" }] }, { action: "Level 2, second" }],
        },
      ],
    },
    {
      title: `${PREFIX} edge: rich text in steps`,
      suite_id: root,
      tags: [TAG, "edge"],
      steps: [
        { action: "Open **Settings** and choose *Profile*", expected_result: "- the name\n- the email\n- the avatar", data: "| Field | Value |\n| --- | --- |\n| Name | Jane |" },
        { action: "Run `curl -X POST https://api.example.com/login`", expected_result: "```json\n{ \"ok\": true }\n```" },
        ...(files.png ? [{ action: `Compare with the picture\n\n![expected](${files.png.url})`, attachments: [files.png.hash, ...(files.csv ? [files.csv.hash] : [])] }] : []),
      ],
    },
    {
      title: `${PREFIX} edge: shared steps twice and in the middle`,
      suite_id: root,
      tags: [TAG, "edge"],
      steps: [
        ...(sharedHashes.get("logIn") ? [{ shared: sharedHashes.get("logIn") }] : []),
        { action: "Open the catalog" },
        ...(sharedHashes.get("openApp") ? [{ shared: sharedHashes.get("openApp") }] : []),
        { action: "Compare the catalog in both", expected_result: "The same products are shown" },
      ],
    },
    { title: `${PREFIX} edge: only text fields`, suite_id: root, tags: [TAG, "edge"], description: "A description.", preconditions: "A precondition.", postconditions: "A postcondition." },
  ];
}

async function createCases(tests: GeneratedTest[]) {
  const existing = new Set<string>();
  for await (const page of qase.cases(code!)) {
    page.forEach((testCase: QaseCase) => existing.add(testCase.title));
  }
  const userId = (await attempt("users", () => qase.users()))?.[0]?.id ?? null;
  const bodies = [...tests.map((test, index) => caseBody(test, index, userId)), ...edgeCases()].filter((body) => !existing.has(String(body.title)));
  log(`Cases: ${existing.size} in the project, ${bodies.length} to create.`);
  if (dry) {
    return;
  }
  let created = 0;
  const CHUNK = 25;
  for (let i = 0; i < bodies.length; i += CHUNK) {
    const chunk = bodies.slice(i, i + CHUNK);
    const ids = await attempt(`cases ${i + 1} to ${i + chunk.length}`, async () => (await qase.send<{ ids: number[] }>("POST", `case/${code}/bulk`, { cases: chunk })).ids);
    if (ids) {
      created += ids.length;
    } else {
      // One case of the chunk is not accepted: create them one by one to find it and keep the rest.
      for (const body of chunk) {
        const id = await attempt(`case "${String(body.title).slice(0, 60)}"`, async () => (await qase.send<{ id: number }>("POST", `case/${code}`, body)).id);
        created += id ? 1 : 0;
      }
    }
    log(`  ${Math.min(i + CHUNK, bodies.length)} of ${bodies.length}`);
  }
  log(`Created ${created} case(s).`);
}

// ------------------------------------------------------------------ cleanup

async function cleanup() {
  const suites = (await qase.suites(code!)).filter((s: QaseSuite) => (s.description ?? "").includes(MARKER) || s.title.startsWith(`${PREFIX} `));
  const cases: QaseCase[] = [];
  for await (const page of qase.cases(code!)) {
    cases.push(...page.filter((c) => c.tags?.some((t) => t.title === TAG) || c.title.startsWith(`${PREFIX} `)));
  }
  const shared = (await qase.sharedSteps(code!)).filter((s: QaseSharedStep) => s.title.startsWith(`${PREFIX} `));
  const milestones = (await qase.milestones(code!)).filter((m: QaseMilestone) => m.title.startsWith(`${PREFIX} `));
  const fields = flag("fields") ? (await qase.customFields()).filter((f) => f.title.startsWith(`${PREFIX} `)) : [];
  log(`To delete in ${code}: ${cases.length} case(s), ${suites.length} suite(s), ${shared.length} shared step(s), ${milestones.length} milestone(s).`);
  if (fields.length > 0) {
    log(`To delete in the whole workspace: custom fields ${fields.map((f) => `"${f.title}"`).join(", ")}.`);
  }
  if (!flag("yes")) {
    log("Nothing is deleted yet. Add --yes to delete.");
    return;
  }
  for (const testCase of cases) {
    await attempt(`case ${testCase.id}`, () => qase.send("DELETE", `case/${code}/${testCase.id}`));
  }
  // Children first, so a parent is empty when its turn comes.
  const depth = (suite: QaseSuite): number => (suite.parent_id ? 1 + depth(suites.find((s) => s.id === suite.parent_id) ?? { id: 0, title: "" }) : 0);
  for (const suite of [...suites].sort((a, b) => depth(b) - depth(a))) {
    await attempt(`suite ${suite.title}`, () => qase.send("DELETE", `suite/${code}/${suite.id}`));
  }
  for (const step of shared) {
    await attempt(`shared step ${step.title}`, () => qase.send("DELETE", `shared_step/${code}/${step.hash}`));
  }
  for (const milestone of milestones) {
    await attempt(`milestone ${milestone.title}`, () => qase.send("DELETE", `milestone/${code}/${milestone.id}`));
  }
  for (const field of fields) {
    await attempt(`custom field ${field.title}`, () => qase.send("DELETE", `custom_field/${field.id}`));
  }
  log("Done.");
}

// ------------------------------------------------------------------ main

async function main() {
  let project: Awaited<ReturnType<typeof qase.project>> | null = null;
  try {
    project = await qase.project(code!);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 0;
    if (status === 401) {
      fail("Qase rejected the API token in QASE_API_TOKEN: it is wrong or was revoked. Create a token in Qase (your profile, API tokens).");
    }
    if (status !== 404) {
      fail(`Cannot read project ${code} from Qase: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!project) {
    if (!flag("create") || flag("cleanup")) {
      // The token works: say which projects it can see, the code is likely one of them.
      const known = await qase.projects().catch(() => []);
      fail(
        `Qase has no project with the code ${code}, or the token cannot see it.` +
          (known.length > 0 ? ` Projects of this token: ${known.map((p) => `${p.code} (${p.title})`).join(", ")}.` : " This token sees no projects.") +
          " Pass one of them with --project, or add --create to create the project.",
      );
    }
    await write(`project ${code}`, () => qase.send("POST", "project", { title: `${PREFIX} seed ${code}`, code, access: "all" }));
  } else {
    log(`Project ${project.title} (${project.code}): ${project.counts?.cases ?? 0} case(s), ${project.counts?.suites ?? 0} suite(s).`);
  }
  if (flag("cleanup")) {
    await cleanup();
    return;
  }
  const tests = generate(SCENARIOS.length + Math.max(0, bulk));
  await uploadFiles();
  await prepareFields();
  await prepareMilestones();
  await prepareSuites(tests);
  await prepareSharedSteps();
  await createCases(tests);
  log(dry ? "Dry run: nothing was written." : `Done. Open the project to check: the cases carry the tag "${TAG}".`);
}

main().catch((error: unknown) => fail(`Stopped: ${error instanceof Error ? error.message : String(error)}`));
