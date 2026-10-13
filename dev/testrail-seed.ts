/**
 * Fills a TestRail project with test cases that cover what a migration can meet, to try both the
 * API migration and the migration of an XML export against a real TestRail.
 *
 *   TESTRAIL_URL=https://you.testrail.io TESTRAIL_EMAIL=you@example.com TESTRAIL_API_KEY=... \
 *   npx tsx dev/testrail-seed.ts [--bulk 300] [--project-name "ATM sample"]
 *
 *   npx tsx dev/testrail-seed.ts --cleanup --yes    # deletes the suites and top sections this script made
 *   npx tsx dev/testrail-seed.ts --dry [--bulk 300]  # no TestRail needed: prints what would be created
 *
 * It creates (or reuses) one project with several suites (or, when the project allows one suite only,
 * with the suites as top sections), nested sections with descriptions,
 * milestones, shared steps and custom fields of every type, bound to that project only. Cases use
 * the Steps, Text, Exploratory and BDD templates, Markdown and HTML text, tables, inline images,
 * attachments, references and estimates; their steps vary in shape (see dev/xray-seed-scenarios.ts).
 * Running it again adds only the cases that are missing.
 *
 * Needs a TestRail administrator: custom fields and projects are created. TestRail has no API to
 * delete custom fields: remove the "ATM ..." fields by hand in Administration, Customizations.
 */
import { HttpClient, HttpError } from "../packages/server/src/http/httpClient.js";
import { sharedRateLimiter } from "../packages/server/src/http/rateLimiter.js";
import { wikiToMarkdown } from "../packages/server/src/xray/wiki.js";
import { generate, random, SCENARIOS, type GeneratedTest, type PreconditionName, type StepTemplate } from "./xray-seed-scenarios.js";

const MARKER = "Created by dev/testrail-seed.ts of allure-testops-migration.";

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
const dryRun = flag("dry");
const env = (name: string) => process.env[name] || (dryRun ? "dry" : fail(`Set the environment variable ${name}. See the top of dev/testrail-seed.ts.`));

const endpoint = dryRun ? "https://testrail.invalid" : env("TESTRAIL_URL");
const projectName = option("project-name") ?? "ATM sample";
const bulk = Number(option("bulk") ?? 0);
const log = (message: string) => console.log(message);

const http = new HttpClient({
  baseUrl: endpoint,
  headers: { Authorization: `Basic ${Buffer.from(`${env("TESTRAIL_EMAIL")}:${env("TESTRAIL_API_KEY")}`).toString("base64")}` },
  // Below the 180 requests per minute of TestRail Cloud Professional.
  rateLimiter: sharedRateLimiter(endpoint, 150),
  onRetry: (info) => log(`  retry ${info.attempt}/${info.of}: ${info.reason}`),
});

const get = <T>(method: string, query?: Record<string, string | number>) => http.get<T>(`index.php?/api/v2/${method}`, query);
const post = <T>(method: string, body: unknown = {}) => http.json<T>("POST", `index.php?/api/v2/${method}`, { body });

/** Every page of a list endpoint; old TestRail versions answer with a plain array. */
async function list<T>(method: string, key: string, query: Record<string, string | number> = {}): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; ) {
    const response = await get<unknown>(method, { ...query, limit: 250, offset });
    if (Array.isArray(response)) {
      return response as T[];
    }
    const page = ((response as Record<string, unknown> | null)?.[key] as T[] | undefined) ?? [];
    items.push(...page);
    if (!(response as { _links?: { next?: string | null } })._links?.next || page.length === 0) {
      return items;
    }
    offset += page.length;
  }
}

async function attempt<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log(`  ! ${what}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface Named {
  id: number;
  name: string;
}

// ------------------------------------------------------------------ text

/** Wiki markup of the scenario library as TestRail Markdown, with TestRail's own table syntax. */
function markdown(wiki: string | undefined): string {
  if (!wiki) {
    return "";
  }
  const lines = wikiToMarkdown(wiki).split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (/^\s*\|/.test(line) && /^\s*\|\s*-{3}/.test(lines[i + 1] ?? "")) {
      out.push(`|||:${cells(line).join("|:")}`);
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        out.push(`||${cells(lines[i]!).join("|")}`);
        i++;
      }
      i--;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** The same text as the HTML the newer TestRail editor stores. */
function html(wiki: string | undefined): string {
  if (!wiki) {
    return "";
  }
  const inline = (text: string) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=$|[\s).,:;!?])/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((\S+?)\)/g, '<a href="$2">$1</a>');
  const blocks: string[] = [];
  const lines = wikiToMarkdown(wiki).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\|/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        if (!/^\s*\|\s*-{3}/.test(lines[i]!)) {
          rows.push(lines[i]!.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
        }
        i++;
      }
      i--;
      blocks.push(`<table><tbody>${rows.map((row, r) => `<tr>${row.map((c) => (r === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (/^\s*- /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*- /.test(lines[i]!)) {
        items.push(`<li>${inline(lines[i]!.replace(/^\s*- /, ""))}</li>`);
        i++;
      }
      i--;
      blocks.push(`<ul>${items.join("")}</ul>`);
    } else if (line.trim()) {
      blocks.push(`<p>${inline(line)}</p>`);
    }
  }
  return blocks.join("");
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJElEQVR42mNk+M+AFTAxkAhGNYxqGNUwqmFUw6iGUQ2jGgYJAAA8TwEQ2XtoNQAAAABJRU5ErkJggg==",
  "base64",
);
const CSV = Buffer.from("login,password\njane,secret\nsam,hunter2\n");

// ------------------------------------------------------------------ project setup

const PRECONDITIONS: Record<PreconditionName, string> = {
  user: "*User* {{jane@example.com}} exists and is *active*.",
  admin: "User {{admin@example.com}} has the *Administrator* role.",
  cart: "The cart holds:\n||Item||Qty||\n|Phone|1|\n|Case|2|",
  sandbox: "The payment sandbox is up, see [the status page|https://status.example.com].",
  device: "A test phone with the latest build is at hand.",
  emptyDb: "The database is empty: run {{make reset-db}}.",
};

/** Custom fields of every type TestRail lets the API create. */
const FIELDS: { name: string; label: string; type: string; options?: Record<string, unknown> }[] = [
  { name: "atm_string", label: "ATM Build", type: "String" },
  { name: "atm_integer", label: "ATM Complexity", type: "Integer" },
  { name: "atm_text", label: "ATM Notes", type: "Text", options: { format: "markdown", rows: "5" } },
  { name: "atm_url", label: "ATM Spec", type: "URL" },
  { name: "atm_checkbox", label: "ATM Flaky", type: "Checkbox" },
  { name: "atm_dropdown", label: "ATM Browser", type: "Dropdown", options: { items: "1, Chrome\n2, Firefox\n3, Safari\n4, Edge" } },
  { name: "atm_multiselect", label: "ATM Platforms", type: "Multiselect", options: { items: "1, Web\n2, iOS\n3, Android\n4, API" } },
  { name: "atm_user", label: "ATM Reviewer", type: "User" },
  { name: "atm_date", label: "ATM Review date", type: "Date" },
  { name: "atm_milestone", label: "ATM Target release", type: "Milestone" },
];

interface CaseField {
  id: number;
  name: string;
  system_name: string;
  type_id: number;
  configs?: { context?: { is_global?: boolean; project_ids?: (number | string)[] | null | string }; options?: { items?: string } }[] | string;
}

async function findOrCreateProject(): Promise<Named & { announcement?: string | null }> {
  const projects = await list<Named & { announcement?: string | null }>("get_projects", "projects");
  const existing = projects.find((p) => p.name === projectName);
  if (existing) {
    log(`Project "${existing.name}" (#${existing.id}) exists, adding what is missing.`);
    return existing;
  }
  // suite_mode 3: several suites, as an XML export is made per suite.
  const created = await post<Named>("add_project", { name: projectName, announcement: MARKER, show_announcement: true, suite_mode: 3 });
  log(`Created project "${created.name}" (#${created.id}).`);
  return { ...created, announcement: MARKER };
}

function appliesTo(field: CaseField, projectId: number): boolean {
  const configs = typeof field.configs === "string" ? (JSON.parse(field.configs) as Exclude<CaseField["configs"], string>) : field.configs;
  return (configs ?? []).some((c) => c.context?.is_global || (Array.isArray(c.context?.project_ids) && c.context.project_ids.map(Number).includes(projectId)));
}

/** System names of the case fields usable in the project, by field name ("preconds", "atm_dropdown"). */
async function prepareFields(projectId: number): Promise<Map<string, string>> {
  let fields = await get<CaseField[]>("get_case_fields");
  for (const wanted of FIELDS) {
    const existing = fields.find((f) => f.name === wanted.name);
    if (existing) {
      if (!appliesTo(existing, projectId)) {
        log(`  ! Field "${wanted.label}" exists but is not enabled for this project. Add the project to it in Administration, Customizations.`);
      }
      continue;
    }
    const created = await attempt(`field ${wanted.label}`, () =>
      post<CaseField>("add_case_field", {
        type: wanted.type,
        name: wanted.name,
        label: wanted.label,
        description: MARKER,
        include_all: true,
        configs: [{ context: { is_global: false, project_ids: [projectId] }, options: { is_required: false, ...wanted.options } }],
      }),
    );
    if (created) {
      log(`  field ${wanted.label} (${created.system_name})`);
    }
  }
  fields = await get<CaseField[]>("get_case_fields");
  const usable = new Map(fields.filter((f) => appliesTo(f, projectId)).map((f) => [f.name, f.system_name]));
  // Standard fields this script fills; without them the matching content is not written.
  const missing = ["preconds", "steps", "expected", "steps_separated", "mission", "goals", ...FIELDS.map((f) => f.name)].filter((name) => !usable.has(name));
  if (missing.length > 0) {
    log(`  ! Not available in this project, so not filled: ${missing.join(", ")}.`);
    const elsewhere = fields.filter((f) => missing.includes(f.name));
    elsewhere.forEach((f) => log(`    "${f.name}" exists as ${f.system_name} but is not enabled for this project.`));
  }
  return usable;
}

// ------------------------------------------------------------------ cases

interface Context {
  projectId: number;
  fields: Map<string, string>;
  templates: Map<string, number>;
  types: Named[];
  priorities: Named[];
  users: Named[];
  milestones: Named[];
  sharedSteps: Record<"logIn" | "openApp", number | null>;
}

/** A custom field value by field name, when the field exists in the project. */
function custom(context: Context, values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const systemName = context.fields.get(name);
    if (systemName && value !== undefined && value !== null && value !== "") {
      result[systemName] = value;
    }
  }
  return result;
}

function stepsField(steps: StepTemplate[], text: (wiki: string | undefined) => string) {
  return steps.map((step) => ({
    content: text(step.action),
    ...(step.result ? { expected: text(step.result) } : {}),
    ...(step.data ? { additional_info: text(step.data) } : {}),
  }));
}

/** The BDD scenario field takes a list of scenarios, each with its Gherkin text. */
function bddScenario(item: GeneratedTest): { content: string }[] {
  return [{ content: `Scenario: ${item.title}\n${item.gherkin}` }];
}

/** The body of add_case for a generated test; `index` drives the variety that is not in the scenario. */
function caseBody(item: GeneratedTest, index: number, context: Context): Record<string, unknown> {
  const rnd = random(index + 1000);
  // One case in five is written as the HTML the newer editor stores.
  const asHtml = index % 5 === 4;
  const text = asHtml ? html : markdown;
  const preconditions = (item.preconditions ?? []).map((name) => PRECONDITIONS[name]).join("\n");
  const byName = (items: Named[], name: string) => items.find((i) => i.name.toLowerCase() === name.toLowerCase())?.id;
  const template = (name: string) => [...context.templates.entries()].find(([key]) => key.toLowerCase().includes(name))?.[1];
  const body: Record<string, unknown> = {
    title: item.title,
    priority_id: byName(context.priorities, item.priority) ?? rnd.pick(context.priorities)?.id,
    type_id: item.type === "Generic" ? byName(context.types, "Automated") : rnd.pick(context.types)?.id,
    ...(rnd.chance(0.4) ? { estimate: rnd.pick(["30s", "2m", "5m", "15m", "1h", "1h 30m"]) } : {}),
    ...(rnd.chance(0.35) ? { refs: rnd.pick(["REQ-1", "REQ-2, REQ-7", "SHOP-101", "SHOP-102, SHOP-250, SHOP-3"]) } : {}),
    ...(rnd.chance(0.3) && context.milestones.length ? { milestone_id: rnd.pick(context.milestones).id } : {}),
    ...custom(context, {
      atm_string: rnd.chance(0.5) ? `build-${100 + (index % 40)}` : undefined,
      atm_integer: rnd.chance(0.5) ? 1 + (index % 5) : undefined,
      atm_text: rnd.chance(0.3) ? text("Reviewed in sprint *12*.\n* check on staging\n* see [the board|https://board.example.com]") : undefined,
      atm_url: rnd.chance(0.3) ? `https://wiki.example.com/spec/${item.component.toLowerCase()}` : undefined,
      atm_checkbox: rnd.chance(0.25),
      atm_dropdown: rnd.chance(0.7) ? 1 + Math.floor(rnd.next() * 4) : undefined,
      atm_multiselect: rnd.chance(0.6) ? [1, 2, 3, 4].filter(() => rnd.chance(0.5)) : undefined,
      atm_user: rnd.chance(0.4) && context.users.length ? rnd.pick(context.users).id : undefined,
      atm_milestone: rnd.chance(0.25) && context.milestones.length ? rnd.pick(context.milestones).id : undefined,
      atm_date: rnd.chance(0.3) ? `${1 + (index % 12)}/${1 + (index % 28)}/2026` : undefined,
      automation_type: item.type === "Generic" ? undefined : 0,
    }),
  };

  if (item.type === "Cucumber") {
    const bdd = template("behaviour") ?? template("bdd");
    if (bdd && context.fields.has("testrail_bdd_scenario")) {
      return { ...body, template_id: bdd, ...custom(context, { testrail_bdd_scenario: bddScenario(item) }) };
    }
    return { ...body, template_id: template("text"), ...custom(context, { preconds: text(preconditions), steps: item.gherkin }) };
  }
  if (item.type === "Generic") {
    return { ...body, template_id: template("text"), ...custom(context, { steps: item.unstructured, expected: "The automated test passes." }) };
  }
  const steps = item.steps ?? [];
  if (item.labels.includes("exploratory")) {
    const mission = steps[0];
    return {
      ...body,
      template_id: template("exploratory"),
      ...custom(context, { mission: text(mission?.data ?? mission?.action), goals: text(steps.slice(1).map((s) => `* ${s.action}`).join("\n")) }),
    };
  }
  // One Manual case in four uses the Text template: steps and expected results as plain text.
  if (index % 4 === 1) {
    return {
      ...body,
      template_id: template("text"),
      ...custom(context, {
        preconds: text(preconditions),
        steps: steps.filter((s) => s.action).map((s, i) => `${i + 1}. ${markdown(s.action)}${s.data ? ` (${markdown(s.data).split("\n")[0]})` : ""}`).join("\n"),
        expected: text(steps.filter((s) => s.result).map((s) => `* ${s.result!.split("\n")[0]}`).join("\n")),
      }),
    };
  }
  const shared = item.calls ? context.sharedSteps[item.calls] : null;
  return {
    ...body,
    template_id: template("steps"),
    ...custom(context, {
      preconds: text(preconditions),
      steps_separated: [...(shared ? [{ shared_step_id: shared }] : []), ...stepsField(steps, text)],
    }),
  };
}

/** Adds a case; a field TestRail refuses (date format, a removed option) is dropped and the case tried again. */
async function addCase(sectionId: number, body: Record<string, unknown>): Promise<Named | null> {
  let current = body;
  for (let round = 0; round < 6; round++) {
    try {
      return await post<Named>(`add_case/${sectionId}`, current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refused = error instanceof HttpError && error.status === 400 ? /Field :?(\w+)/.exec(message)?.[1] : undefined;
      if (!refused || !(refused in current)) {
        log(`  ! case "${String(body.title)}": ${message}`);
        return null;
      }
      log(`  field ${refused} was refused for "${String(body.title)}": ${message.replace(/^.*failed with 400:?\s*/, "")}; trying without it`);
      const { [refused]: _dropped, ...rest } = current;
      current = rest;
    }
  }
  return null;
}

// ------------------------------------------------------------------ run

/** Suite of a scenario folder: "/API/v2/Products" lives in the suite "API" under "v2 > Products". */
const SUITES: Record<string, string> = { Web: "Web shop", API: "API", Mobile: "Mobile app" };
const SECTION_NOTES: Record<string, string> = {
  Auth: "Everything about signing in: passwords, **2FA**, SSO and sessions.",
  Shop: "Catalog, search, cart and checkout.\n\n|||:Owner|:Channel\n||Shop team|#shop-qa",
  Checkout: "Needs the payment sandbox.",
};

async function seed() {
  const project = await findOrCreateProject();
  const projectId = project.id;
  log("Custom fields");
  const fields = await prepareFields(projectId);

  const templates = new Map((await get<Named[]>(`get_templates/${projectId}`)).map((t) => [t.name, t.id]));
  log(`Templates: ${[...templates.keys()].join(", ")}`);
  const users = (await attempt("users", () => list<Named & { is_active?: boolean }>(`get_users/${projectId}`, "users")))?.filter((u) => u.is_active !== false) ?? [];

  log("Milestones");
  const milestones = await list<Named>(`get_milestones/${projectId}`, "milestones");
  for (const name of ["Release 1.0", "Release 2.0", "Release 2.1"]) {
    if (!milestones.some((m) => m.name === name)) {
      const created = await attempt(`milestone ${name}`, () => post<Named>(`add_milestone/${projectId}`, { name, description: MARKER }));
      if (created) milestones.push(created);
    }
  }
  const parent = milestones.find((m) => m.name === "Release 2.1");
  if (parent && !milestones.some((m) => m.name === "Sprint 12")) {
    const sub = await attempt("sub-milestone", () => post<Named>(`add_milestone/${projectId}`, { name: "Sprint 12", parent_id: parent.id }));
    if (sub) milestones.push(sub);
  }

  log("Shared steps");
  const existingShared = (await attempt("shared steps", () => list<{ id: number; title: string }>(`get_shared_steps/${projectId}`, "shared_steps"))) ?? [];
  const stepsName = fields.get("steps_separated") ?? "custom_steps_separated";
  const sharedStep = async (title: string, steps: Record<string, string>[]) =>
    existingShared.find((s) => s.title === title)?.id ??
    (await attempt(`shared step ${title}`, () => post<{ id: number }>(`add_shared_step/${projectId}`, { title, [stepsName]: steps })))?.id ??
    null;
  const openApp = await sharedStep("Open the app and accept cookies", [
    { content: "Start the app", expected: "The start page is shown" },
    { content: "Accept **all** cookies", expected: "The banner disappears" },
  ]);
  const logIn = await sharedStep("Log in as jane", [
    { content: "Open the login page", additional_info: "URL: `/login`" },
    { content: "Enter `jane@example.com` and the password", expected: "The dashboard opens" },
  ]);

  const context: Context = {
    projectId,
    fields,
    templates,
    types: await get<Named[]>("get_case_types"),
    priorities: await get<Named[]>("get_priorities"),
    users,
    milestones,
    sharedSteps: { logIn, openApp },
  };

  log("Suites and sections");
  const suites = await list<Named>(`get_suites/${projectId}`, "suites");
  // A project with a single repository (suite mode 1 or 2) cannot get more suites: the suite names become top sections.
  let singleSuite = (await get<{ suite_mode?: number }>(`get_project/${projectId}`)).suite_mode !== 3;
  const onlySuite = () => suites[0]?.id ?? fail("The project has no suite to put cases in.");
  if (singleSuite) {
    log(`  The project keeps all cases in one suite ("${suites[0]?.name ?? "?"}"): Web shop, API and Mobile app become its top sections.`);
  }
  const suiteId = async (name: string) => {
    if (singleSuite) {
      return onlySuite();
    }
    let suite = suites.find((s) => s.name === name);
    if (!suite) {
      try {
        suite = (await post<Named>(`add_suite/${projectId}`, { name, description: `${MARKER}\n\nSuite **${name}**.` }))!;
      } catch (error) {
        // Some instances create single suite projects whatever was asked for.
        if (error instanceof HttpError && error.status === 403 && /single test suite/i.test(error.message)) {
          singleSuite = true;
          log("  The project supports a single suite only: the suite names become top sections.");
          return onlySuite();
        }
        throw error;
      }
      suites.push(suite);
    }
    return suite.id;
  };
  const sections = new Map<string, number>();
  /** Case id by title, per suite. */
  const titles = new Map<number, Map<string, number>>();
  const sectionId = async (suite: number, path: string[]): Promise<number> => {
    const key = `${suite}/${path.join("/")}`;
    if (!sections.has(key)) {
      if (!titles.has(suite)) {
        // First visit of the suite: what is there already, so a second run adds only the missing cases.
        const present = await list<{ id: number; name: string; parent_id: number | null }>(`get_sections/${projectId}`, "sections", { suite_id: suite });
        const pathOf = (s: { name: string; parent_id: number | null }): string[] => {
          const up = present.find((p) => p.id === s.parent_id);
          return up ? [...pathOf(up), s.name] : [s.name];
        };
        present.forEach((s) => sections.set(`${suite}/${pathOf(s).join("/")}`, s.id));
        titles.set(suite, new Map((await list<{ id: number; title: string }>(`get_cases/${projectId}`, "cases", { suite_id: suite })).map((c) => [c.title, c.id])));
      }
      if (!sections.has(key)) {
        const parentId = path.length > 1 ? await sectionId(suite, path.slice(0, -1)) : null;
        const name = path[path.length - 1]!;
        // Top sections carry the marker, so the cleanup deletes only what this script made.
        const description = [SECTION_NOTES[name], parentId ? null : MARKER].filter(Boolean).join("\n\n");
        const created = await post<Named>(`add_section/${projectId}`, { suite_id: suite, name, description, ...(parentId ? { parent_id: parentId } : {}) });
        sections.set(key, created.id);
      }
    }
    return sections.get(key)!;
  };

  const generated = generate(SCENARIOS.length + bulk);
  log(`Cases: ${generated.length} (${SCENARIOS.length} scenarios${bulk > 0 ? ` and ${bulk} variations` : ""})`);
  let created = 0;
  let skipped = 0;
  let repaired = 0;
  for (const [index, item] of generated.entries()) {
    const [top = "Web", ...rest] = item.folder.split("/").filter(Boolean);
    const suiteName = SUITES[top] ?? SUITES.Web!;
    const suite = await suiteId(suiteName);
    // Keep the top folder as a section when it is not the suite itself, and nest a few cases deeper.
    const path = [...(singleSuite ? [suiteName] : []), ...(SUITES[top] ? [] : [top]), ...rest, ...(index % 11 === 10 ? ["Edge cases", "Rare"] : [])];
    const section = await sectionId(suite, path.length > 0 ? path : ["General"]);
    const existing = titles.get(suite)?.get(item.title);
    if (existing !== undefined) {
      skipped++;
      // BDD cases made by an earlier version of this script have no scenario: fill it in.
      const bddField = fields.get("testrail_bdd_scenario");
      if (item.type === "Cucumber" && bddField && [...templates.keys()].some((name) => /behaviou?r|bdd/i.test(name))) {
        if (await attempt(`scenario of C${existing}`, () => post(`update_case/${existing}`, { [bddField]: bddScenario(item) }))) {
          repaired++;
        }
      }
      continue;
    }
    const added = await addCase(section, caseBody(item, index, context));
    if (!added) {
      continue;
    }
    created++;
    titles.get(suite)?.set(item.title, added.id);
    if (index % 9 === 0) {
      // An inline image in the preconditions and a file that is only attached.
      const image = await attempt(`attachment of C${added.id}`, () =>
        http.upload<{ attachment_id: number | string }>(`index.php?/api/v2/add_attachment_to_case/${added.id}`, {}, [{ field: "attachment", name: "screenshot.png", data: PNG, contentType: "image/png" }]),
      );
      await attempt(`attachment of C${added.id}`, () =>
        http.upload(`index.php?/api/v2/add_attachment_to_case/${added.id}`, {}, [{ field: "attachment", name: "test-data.csv", data: CSV, contentType: "text/csv" }]),
      );
      const preconds = fields.get("preconds");
      if (image && preconds) {
        await attempt(`inline image of C${added.id}`, () =>
          post(`update_case/${added.id}`, { [preconds]: `See the screenshot:\n\n![](index.php?/attachments/get/${image.attachment_id})\n\n${markdown((item.preconditions ?? []).map((n) => PRECONDITIONS[n]).join("\n"))}` }),
        );
      }
    }
    if (created % 25 === 0) {
      log(`  ${created} created...`);
    }
  }
  log(`Done: ${created} case(s) created, ${skipped} already there${repaired > 0 ? ` (${repaired} BDD scenario(s) written again)` : ""}.`);
  log(`Project: ${http.baseUrl}index.php?/projects/overview/${projectId}`);
  log(`For the XML migration, export ${singleSuite ? "the test cases" : "each suite"}: Test Cases, the Export icon, XML.`);
}

async function cleanup() {
  const project = (await list<Named & { announcement?: string | null }>("get_projects", "projects")).find((p) => p.name === projectName);
  if (!project) {
    fail(`No project named "${projectName}".`);
  }
  // Only suites and top sections this script made (their description says so) are deleted, with everything
  // in them; whatever else the project holds stays.
  const made = (item: { description?: string | null }) => Boolean(item.description?.includes(MARKER));
  const allSuites = await list<Named & { description?: string | null }>(`get_suites/${project.id}`, "suites");
  const singleSuite = (await get<{ suite_mode?: number }>(`get_project/${project.id}`)).suite_mode !== 3;
  // The only suite of a single suite project cannot be deleted.
  const suites = singleSuite ? [] : allSuites.filter(made);
  const topSections: Named[] = [];
  for (const suite of allSuites.filter((candidate) => !suites.includes(candidate))) {
    const all = await list<Named & { parent_id: number | null; description?: string | null }>(`get_sections/${project.id}`, "sections", { suite_id: suite.id });
    topSections.push(...all.filter((section) => !section.parent_id && made(section)));
  }
  log(`Project "${project.name}" (#${project.id}): ${suites.length} suite(s) and ${topSections.length} top section(s) made by this script, with all their sections and cases.`);
  if (suites.length + topSections.length === 0) {
    log("Nothing to delete.");
    return;
  }
  if (!flag("yes")) {
    log("Nothing deleted. Run again with --cleanup --yes to delete them. The project, milestones, shared steps and custom fields stay.");
    return;
  }
  for (const section of topSections) {
    await attempt(`delete section ${section.name}`, () => post(`delete_section/${section.id}`));
    log(`  deleted section ${section.name}`);
  }
  for (const suite of suites) {
    await attempt(`delete suite ${suite.name}`, () => post(`delete_suite/${suite.id}`));
    log(`  deleted suite ${suite.name}`);
  }
  log("Done. The project, its other content and the custom fields stay.");
}

/** Prints what a run would create, with the default TestRail fields and templates, without any request. */
function dry() {
  const names = ["preconds", "steps", "expected", "steps_separated", "mission", "goals", "automation_type", "testrail_bdd_scenario", ...FIELDS.map((f) => f.name)];
  const context: Context = {
    projectId: 1,
    fields: new Map(names.map((name) => [name, `custom_${name}`])),
    templates: new Map([["Test Case (Text)", 1], ["Test Case (Steps)", 2], ["Exploratory Session", 3], ["Behaviour Driven Development", 4]]),
    types: ["Acceptance", "Automated", "Functional", "Other", "Regression", "Smoke & Sanity"].map((name, i) => ({ id: i + 1, name })),
    priorities: ["Low", "Medium", "High", "Critical"].map((name, i) => ({ id: i + 1, name })),
    users: [{ id: 1, name: "You" }],
    milestones: [{ id: 1, name: "Release 1.0" }],
    sharedSteps: { logIn: 11, openApp: 12 },
  };
  const generated = generate(SCENARIOS.length + bulk);
  const bodies = generated.map((item, index) => caseBody(item, index, context));
  const templateName = (id: unknown) => [...context.templates.entries()].find(([, value]) => value === id)?.[0] ?? "?";
  const count = (key: (body: Record<string, unknown>) => string) =>
    Object.entries(bodies.reduce<Record<string, number>>((all, body) => ((all[key(body)] = (all[key(body)] ?? 0) + 1), all), {}))
      .map(([name, n]) => `${name}: ${n}`)
      .join(", ");
  log(`${bodies.length} case(s).`);
  log(`By template: ${count((b) => templateName(b.template_id))}`);
  log(`Text as HTML: ${bodies.filter((b) => JSON.stringify(b).includes("<p>")).length}`);
  const steps = bodies.map((b) => b.custom_steps_separated as { expected?: string; shared_step_id?: number }[] | undefined).filter((s) => s !== undefined);
  log(`Separated steps: ${steps.length} case(s), ${steps.filter((s) => s.every((x) => !x.expected)).length} without any expected result, ${steps.filter((s) => s.some((x) => x.shared_step_id)).length} with a shared step, up to ${Math.max(...steps.map((s) => s.length))} steps.`);
  const suites = new Set(generated.map((g) => SUITES[g.folder.split("/").filter(Boolean)[0] ?? "Web"] ?? SUITES.Web));
  log(`Suites: ${[...suites].join(", ")}`);
  for (const index of [0, 4, 5].filter((i) => i < bodies.length)) {
    log(`\nCase ${index + 1}, folder ${generated[index]!.folder}:\n${JSON.stringify(bodies[index], null, 2)}`);
  }
}

try {
  await (dryRun ? dry() : flag("cleanup") ? cleanup() : seed());
} catch (error) {
  // A request outside the tolerant steps failed (wrong URL or key, no administrator rights).
  fail(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
}
