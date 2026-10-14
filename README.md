# Allure TestOps Migration

A web tool that moves test cases into [Allure TestOps](https://qameta.io/) from **TestRail**, **Xray Cloud**, **Qase**, any **CSV file** or an **XML export** of another test management tool.

Everything is configured in the browser: connect the systems, map the source structure and fields to Allure TestOps using live data from both sides, preview a converted case, do a dry run, then migrate. Running the migration again updates the migrated cases instead of duplicating them.

## Quick start

You need Docker with Compose.

```bash
mkdir ato-migration
cd ./ato-migration
curl -O https://raw.githubusercontent.com/cheshi-mantu/allure-testops-migration/main/docker-compose.yml
docker compose up -d
```

Open <http://localhost:8080>, create a profile and follow the steps.

Profiles and run logs are stored in the `migration-data` Docker volume. Use **Export to JSON** in the profile menu to move a profile to another machine and **Import** on the start page to load it. Credentials are left out of exports unless you tick *Include credentials*.

### Without Docker

You need Node.js 22.12 or later with npm, and git.

```bash
git clone https://github.com/cheshi-mantu/allure-testops-migration.git
cd allure-testops-migration
npm ci
npm run build
HOST=127.0.0.1 npm start
```

Open <http://localhost:8080>. Profiles, uploaded files and run logs are kept in the `.data` folder of the directory you start from. `npm start` runs in the foreground: stop it with Ctrl+C, start it again with the same command, and the profiles are still there.

The tool has no login, so `HOST=127.0.0.1` keeps it reachable from this computer only; without it the tool listens on every network interface. Other settings, also as environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port of the UI and the API |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `./.data` | Folder for profiles, files and run logs |
| `LOG_LEVEL` | `info` | Server log level: `debug`, `info`, `warn` or `error` |

On Windows (PowerShell) set them before starting, for example `$env:HOST="127.0.0.1"; $env:PORT="9000"; npm start`.

To update, stop the tool, then:

```bash
git pull
npm ci
npm run build
HOST=127.0.0.1 npm start
```

## What you need

- **TestRail**: the URL, a user email and an API key (*My Settings → API Keys*). The API must be enabled in *Administration → Site Settings → API*. Read access to the project is enough.
- **Xray Cloud**: the Jira Cloud site, the email and an API token of an Atlassian account that can browse the project (*id.atlassian.com → Security → API tokens*), and an Xray API key: client id and client secret (*Jira → Apps → Xray → API Keys*).
- **Qase**: an API token (*your profile → API tokens*) of a user who can read the project.
- **CSV**: the file. Exports from spreadsheets, other test management tools and Allure TestOps itself work.
- **XML**: the file. An export with one element per test case, for example from TestRail or TestLink.
- **Allure TestOps**: the URL and an API token (*Your profile → API tokens*) of an account that can edit test cases in the target project. Listing users for owner mapping needs administrator rights; without them owners can still be typed in.

## The steps

1. **Connections.** TestRail and Allure TestOps credentials with a *Test connection* button. An optional TestRail session cookie is only needed when inline images fail to download on some TestRail versions. The TestRail API rate limit is set here too, see below.
2. **Projects.** The TestRail project, optionally some suites or a list of case ids for a trial run, and the target Allure TestOps project.
3. **Suites & sections.** The tool scans the section tree of the selected suites and shows how deep it is and which sections sit on each level. Each level gets its own Allure TestOps custom field (for example *Epic*, *Feature*, *Story*) instead of generic `Section1..N` fields. Levels deeper than the ones you map are either joined into the last mapped level (`Login / Errors`) or dropped. The suite name can go to its own field. The tool can create an Allure TestOps tree built from these fields.
4. **Fields.** Every TestRail field (system and custom) with its type, how often it is filled and example values from sampled cases. Choose a target for each: custom field, tags, layer, status, owner, links, issues, description, precondition, expected result, comment or scenario. Fields with a list of values (dropdowns, priorities, types, users, milestones, checkboxes) show all values with counts; each can be renamed, pointed at an existing Allure TestOps value or skipped. TestRail users are matched to Allure TestOps accounts by email automatically.
5. **Options.** Migration tag prefix, extra tag, link back to TestRail, text format (HTML detection), how plain text steps are split, where tables of Gherkin Examples go, attachments, shared steps, deleted cases and parallelism.
6. **Preview.** Converts one real case with the current settings and shows exactly what will be written, including custom fields, text, scenario, attachments and warnings. Nothing is written.
7. **Run.** A dry run converts every case and checks the plan against Allure TestOps: custom fields and values that will be created, unknown owners and statuses, issues without an integration. The migration shows live progress and a log with links to both systems. Runs can be stopped and repeated.

## How TestRail maps to Allure TestOps

| TestRail | Allure TestOps |
| --- | --- |
| Case title | Test case name |
| Suite | Custom field of your choice (optional) |
| Section levels 1..N | One custom field per level, joined or dropped below the last mapped level |
| Separated steps (`custom_steps_separated`) | Scenario: step, "additional info" as a nested step, expected result |
| Shared steps | Shared steps named `<title> [<TestRail id>]` |
| Text steps (`custom_steps`) | Scenario, one step per line or a single step |
| Preconditions, expected result, other text fields | Precondition, expected result or description, with optional headings |
| Dropdowns, priority, type, milestone, checkboxes | Custom fields, tags, layer or status, with value mapping |
| Created by / user fields | Owner, with user mapping |
| References | Issues (with an issue tracker integration) or links |
| Inline images and case attachments | Test case attachments; images keep their place in text |
| Tables (TestRail table syntax and HTML) | Markdown tables in text fields; CSV attachments in steps |
| Links to other TestRail cases | Links to the migrated Allure TestOps cases |

Every migrated case gets the tag `testrail:<case id>` (the prefix is configurable). Reruns find cases by this tag, so the tool can continue or refresh a migration, including one made with the previous command line migration tool when the same prefix and shared step names are used.

## Xray Cloud

Create a profile with *Xray Cloud* as the source. The steps are Connections, Projects, Folders, Fields, Options, Preview and Run.

Xray keeps the details of a test (type, steps, Cucumber or generic definition, folder, preconditions, test sets and plans) and Jira keeps the issue (summary, description, all system and custom fields, comments, links, attachments), so the tool reads both: Jira through its REST API with the account's API token, Xray through its GraphQL API with the API key. The Xray API URL is `https://xray.cloud.getxray.app` for most sites; sites with data residency use their region (`us.`, `eu.` or `au.xray.cloud.getxray.app`).

- **Projects.** The Jira project, an optional JQL filter (for example `labels = regression`) and an optional list of issue keys for a trial run. The tool finds the issue type Xray uses for tests in the project.
- **Folders.** The folders of the test repository map to one custom field per level, like TestRail sections, including the tree.
- **Fields.** Every attribute of the tests is listed with how often it is filled and example values from sampled tests, and gets a target of your choice:
  - Xray: test type, steps of Manual tests, the definition of Cucumber and Generic tests, preconditions, test sets, test plans, the full folder path;
  - Jira: description, environment, labels, priority, components, versions, assignee, reporter, status, dates, every custom field (text, select, multi-select, user, URL, number...), comments, and issue links by direction (`tests`, `is blocked by`...).
  
  Fields with a list of values show the values with counts; each can be renamed, pointed at an existing Allure TestOps value or skipped. Jira users are matched to Allure TestOps accounts by email.

| Xray and Jira | Allure TestOps (suggested, can be changed) |
| --- | --- |
| Summary | Test case name |
| Folder levels 1..N | One custom field per level, and a tree |
| Steps (action, data, expected result, step custom fields, step files) | Scenario: step, data as a nested step, expected result, attachments |
| Step calling another test | Shared step named `<key> <summary> [<issue id>]`, or the called steps copied in |
| Cucumber scenario / Generic definition | Description (Gherkin in a code block), or the scenario, one step per line |
| Preconditions | Precondition (several are listed with their keys) |
| Test type, test sets, test plans | Custom fields |
| Description, other rich text fields | Description, Markdown with images |
| Labels | Tags |
| Priority, components, versions, select fields | Custom fields, with value mapping |
| Assignee | Owner, matched by email |
| Requirements (`tests` links) | Issues of the Jira integration of the project |
| Issue key | Link back to the issue (`Jira CALC-12`) and, optionally, a test key through an integration chosen on the Options step |
| Comments | Comments |
| Issue attachments, images in text | Test case attachments; images keep their place in text |

Every migrated case gets the tag `xray:<issue key>`, in lower case like every tag: `xray:calc-12`. Xray step text and definitions are converted from Jira wiki markup; step text becomes plain text, as Allure TestOps shows step text without formatting.

## Qase

Create a profile with *Qase* as the source. The steps are Connections, Projects, Suites, Fields, Options, Preview and Run. The tool reads Qase through its public REST API with an API token and never writes to it.

- **Connections.** The API token and the plan of the workspace. Qase limits API requests for the whole workspace: 150 a minute on Free, 300 on Startup, 600 on Teams and Business, 1000 on Enterprise, and at the same time a sixth of that in any 10 seconds. The tool paces all its requests to one Qase below the limit of the chosen plan and waits for as long as Qase asks when it still answers "too many requests"; the run log says how many requests were sent and how long the tool waited. A dedicated Qase has its own API and web addresses, set under *addresses for a dedicated Qase*.
- **Projects.** The Qase project, optionally some suites (with everything inside them) or a list of case ids for a trial run.
- **Suites.** Suites nested in suites map to one custom field per level, like TestRail sections, including the tree.
- **Fields.** Every attribute of the cases is listed with how often it is filled and example values from sampled cases, and gets a target of your choice:

| Qase | Allure TestOps by default |
| --- | --- |
| Description, pre-conditions | Description, precondition |
| Post-conditions | Description, under its own heading |
| Parameters | Examples of the test case: every combination of the values, while the parameters of a group change together. More than 100 combinations stay in the description as text |
| Steps (classic) | Scenario: action, data and expected result, nested steps, files of steps |
| Steps (Gherkin) | Scenario, one step per line; an Examples table stays with its line |
| Shared steps | Allure TestOps shared steps, or copied into each case |
| Severity, priority, type, behavior, automation status, milestone | Custom fields with the same names; "Not set" is skipped |
| Layer, status | Test layer, status (Actual to Active, Deprecated to Outdated) |
| Is flaky | Custom field Flaky with the value Yes |
| Tags, author | Tags, owner (matched to Allure TestOps users by email) |
| Linked issues | Issues of an issue tracker integration, or links |
| Custom fields of the project | Custom fields with the same names; URL fields as links, text fields in the description |
| Files of the case and of steps, images in text | Attachments; images keep their place in text |

Every migrated case gets the tag `qase:<project code>-<case id>`, for example `qase:demo-12`, and a link back to the case in Qase. Qase text is Markdown and is kept as it is.

## Values as they are written

Every value the migration writes is trimmed: spaces at the start and the end are removed, and values that are empty after that are left out. This covers names, text, custom field values, tags, links, issues, members, examples and steps.

The test layer and the status are written in lower case, `e2e` and `draft`. Allure TestOps layers and statuses are matched without regard to case, so an existing layer `E2E` or status `Draft` is used as it is; a layer the migration creates is created in lower case.

Every tag the migration writes is in lower case too: the migration tag, the additional tag and the tags that come from source fields (`Smoke` and `smoke` become one tag `smoke`). A case migrated earlier with a tag as the source spells it, for example `xray:CALC-12`, is still found on a rerun, and its tags are rewritten in lower case.

## Gherkin Examples

The table under `Examples:` of a Scenario Outline is read as a whole in every source: Gherkin cases of Qase, Cucumber tests of Xray, BDD scenarios of TestRail, and any text of a CSV or XML file mapped to the scenario. The Options step says where it goes: a Markdown file `examples.md` attached to the step that says Examples (the default), or examples of the test case, one per row with the column titles as parameter names, and then the Examples step is left out of the scenario. Reruns replace the examples of the case.

## CSV files

Create a profile with *CSV file* as the source. The steps are Connection (Allure TestOps only), CSV file, Project, Sections, Columns, Options, Preview and Run.

- **File library.** Uploaded files are kept in the data volume. Any profile can pick a file that is already there, and a file used by a profile cannot be deleted. The file itself is not part of a profile export; after importing a profile on another machine, upload the file again.
- **Reading.** Delimiter (`,` `;` tab `|`) and encoding (UTF-8, UTF-16, Windows-1252 and others) are detected automatically and can be set by hand. Quoted cells may contain delimiters and line breaks. The first rows are shown exactly as the tool reads them.
- **Rows and cases.** A case is one row, or several: rows without a name (or with the same id as the row before) continue the previous case, the usual layout of exports with one step per row. The tool detects this.
- **Columns.** Every column gets a target suggested from its header and content: name, case id, description, precondition, expected result, scenario, expected results of steps, custom field, tags, layer, status, owner, member with a role, links, issues, comment, or an Allure TestOps id to update existing cases. Columns with a short list of values show all values with counts, and each value can be renamed, pointed at an existing Allure TestOps value or skipped. Multi-value cells are split by a separator.
- **Sections.** A column with a path such as `Web > Checkout > Payment` or `/Web/Checkout/Payment` is detected; its levels are mapped to custom fields exactly like TestRail sections, including the tree.
- **Steps.** The scenario cell may use one step per line, numbered steps, indentation for sub-steps (tabs or spaces), the Allure TestOps export syntax (`[step 1]`, `[expected.step 1.1]`), a custom regular expression, or be a single step; the format is detected. Expected results come from a marker inside the steps (for example `Expected:`) or from a separate column, matched to the steps by position.
- **Reruns.** Cases are tagged `csv:<case id>` (or a hash of the name when the file has no id column), so running again updates the same cases.

CSV files carry text only: attachments and shared steps are not part of this source.

## XML files

Create a profile with *XML file* as the source. The steps are Connection (Allure TestOps only), XML file, Project, Sections, Fields, Options, Preview and Run.

There is one XML source for every tool. The file is read by its structure, not by the name of the tool that made it, so exports of TestRail (*Test Cases → Export → XML*), TestLink and other test management tools work the same way:

- **Test cases.** The element that repeats and has a title or name is a test case; `case`, `testcase`, `test` and similar names are preferred. The XML file step shows the detected element, the number of cases and the first cases as they are read. When the guess is wrong, choose another element from the list.
- **Fields.** Child elements and attributes of a case become fields, named by their path inside the case, for example `custom/preconds` or `@name`. A value wrapped with its id (`<priority><id>3</id><value>High</value></priority>`) reads as the value. A list of values (`<platforms><item>…</item><item>…</item></platforms>`) is one field with several values. A list of name and value pairs, the usual form of custom fields, gives one field per name. A list of records, such as attachments, gives a field per child (`attachments/name`, `attachments/url`).
- **Steps.** A list of step elements inside a case becomes the scenario. The parts of a step are recognised by their names: action (`content`, `actions`, `step`…), expected result (`expected`, `expectedresults`…) and data (`additional_info`, `data`…). Steps without an expected result are kept. Steps written as text in one field, including BDD scenarios, can be mapped to the scenario too, with the same step formats as in CSV files. A case takes its scenario from the first of these fields that is filled.
- **Sections.** The named elements around a case (suites, sections, folders, at any depth) are its section path. Its levels are mapped to custom fields on the Sections step exactly like TestRail sections, including the tree.
- **Mapping.** Every field gets a suggested target from its name and content, the same way as CSV columns, and fields with a short list of values show all values with counts for renaming or skipping. Technical values (internal ids, order numbers) are set to *Do not migrate*. Numeric codes of known exports are translated as a first suggestion, for example TestLink importance `3` to `High`.
- **Reruns.** Cases are tagged `<prefix>:<case id>` with the id as it is written in the file, for example `xml-regression:c1697`, or a hash of the name when the file has no id.

- **Attached files.** An XML file holds the addresses of attached files and of images inside text, not the files. By default a field with such addresses (suggested target *Attachments*) gives links named after the files, and images in text become links. To attach the files themselves, turn on *Download attached files* on the Connection step and enter the address of the source system with a user and password or API key, or a request header. Files listed in fields mapped to *Attachments* are then downloaded and attached to the cases, and images keep their place in text and steps. *Test download* reads the first file the XML refers to and says what is wrong when it cannot. Files are downloaded only from the address you enter and the credentials are sent only to it; addresses on other hosts stay links. A file that cannot be downloaded does not stop the migration: the case is migrated, the run lists the problem, and running again adds the file.

Shared steps are not part of this source.

## TestRail API rate limit

TestRail Cloud allows 180 API requests per minute per instance on Professional and 300 on Enterprise; TestRail Server has no limit ([TestRail docs](https://support.testrail.com/hc/en-us/articles/7077083596436-Introduction-to-the-TestRail-API)). The tool paces its requests to stay within the limit chosen on the Connections step: Professional (default), Enterprise, a custom number, or off for TestRail Server. The limit covers everything the tool sends to that TestRail instance at once (discovery, previews and runs of all profiles). Because the limit is shared with every other API user of the instance, such as CI jobs posting results, a custom value below the plan limit leaves them room. If TestRail still answers 429, the tool waits for the time given in `Retry-After` before sending anything else.

A migration needs roughly one TestRail request per case, plus one per attachment and shared step; case lists are read 250 at a time. The dry run estimates the number of requests and the minimum duration, and every run reports how many requests it sent and how long it waited for the limit.

## Security

- The UI has no login. `docker-compose.yml` publishes it on `127.0.0.1` only; do not expose it on a shared network without a protecting proxy.
- Credentials are stored in the data volume in files readable only by the container user. The API never sends them back to the browser.
- TLS verification can be turned off per connection for self-signed certificates; it is on by default.

## Development

Requirements: Node.js 22.12+.

```bash
npm install
npm run build        # shared, server, web, mocks
npm test             # unit tests and an end-to-end migration against fake servers
```

Run locally with fake TestRail and Allure TestOps servers:

```bash
npm run dev:mocks    # TestRail on :4001, Allure TestOps on :4002, Jira and Xray Cloud on :4003, Qase on :4004
npm run dev:server   # API and UI on :8080 (UI from packages/web/dist)
npm run dev:web      # optional: UI with hot reload on :5173, proxies /api to :8080
```

Or everything in containers, built from the sources:

```bash
docker compose -f dev-compose.yml up --build -d
docker compose -f dev-compose.yml run --rm --build tests -d
```

Fake server credentials: TestRail user `demo@example.com` with API key `demo-api-key`, Allure TestOps token `demo-api-token`. Inside `dev-compose.yml` use `http://mocks:4001` and `http://mocks:4002` as URLs; from the host use `http://localhost:4001` and `http://localhost:4002`. The fake Jira and Xray Cloud run on port 4003 (`http://mocks:4003` or `http://localhost:4003` for both the Jira site and the Xray API URL): Jira `demo@example.com` with token `demo-jira-token`, Xray client id `demo-client-id` and secret `demo-client-secret`. The fake Qase runs on port 4004 with the API token `demo-qase-token`: enter `http://mocks:4004` or `http://localhost:4004` as the Qase API address.

### Test data in a real Xray Cloud

`dev/xray-seed.ts` fills a Jira Cloud project with Xray tests that cover what the migration reads: Manual tests with formatted steps, step files and called tests, Cucumber and Generic tests, preconditions (also more than ten on one test), folders, test sets and plans, labels, priorities, components, versions, descriptions with images and tables, comments, attachments and requirement links. It also creates about 30 realistic scenarios of a web shop, its API and mobile app (`dev/xray-seed-scenarios.ts`), and `--bulk N` adds N variations of them (browsers, locales, roles, negative input) for paging and speed. Manual tests vary in shape: steps as written, steps only, steps without expected results, one check at the end, and long tests of 15 to 25 steps with or without expected results; the label `shape-...` tells which. Everything it creates is labelled `atm-seed`, and `--cleanup --yes` deletes it again. The project needs the Xray issue types and Story.

```bash
export JIRA_URL=https://yourcompany.atlassian.net JIRA_EMAIL=you@example.com JIRA_API_TOKEN=...
export XRAY_CLIENT_ID=... XRAY_CLIENT_SECRET=...   # XRAY_URL for regional sites
npx tsx dev/xray-seed.ts --project KEY --bulk 300
npx tsx dev/xray-seed.ts --project KEY --cleanup --yes
```

### Test data in a real Qase

`dev/qase-seed.ts` fills a Qase project with the same scenarios: suites three levels deep, custom fields of every type (their titles start with "ATM"), milestones, shared steps, attachments, and cases with classic steps (data, expected results, nested steps, files, shared steps), Gherkin cases, cases without steps, parameters, tags and every system field. It is paced for the rate limit of the Free plan. Running it again adds only what is missing. `--dry` shows what would be created, `--create` creates the project when it does not exist. `--cleanup --yes` removes the seeded suites, cases, shared steps and milestones; custom fields belong to the whole workspace, so they are deleted only with `--fields`.

```bash
export QASE_API_TOKEN=...   # QASE_URL for a dedicated Qase
npx tsx dev/qase-seed.ts --project CODE --bulk 300
npx tsx dev/qase-seed.ts --project CODE --cleanup --yes
```

### Test data in a real TestRail

`dev/testrail-seed.ts` fills one TestRail project with the same scenarios, for trying both the API migration and the migration of an XML export: several suites, nested sections with descriptions, milestones, shared steps, custom fields of every type (bound to that project only), cases on the Steps, Text, Exploratory and BDD templates, Markdown and HTML text, tables, inline images, attachments, references and estimates. It needs a TestRail administrator. `--dry` prints what would be created without touching TestRail; An existing project with that name is reused, also one that allows a single suite only: the suites then become top sections. `--cleanup --yes` deletes only the suites and top sections the script made, with their cases, and keeps the project, its other content and the fields, because TestRail has no API to delete custom fields (remove the "ATM ..." fields in Administration, Customizations).

```bash
export TESTRAIL_URL=https://yourcompany.testrail.io TESTRAIL_EMAIL=you@example.com TESTRAIL_API_KEY=...
npx tsx dev/testrail-seed.ts --dry --bulk 300
npx tsx dev/testrail-seed.ts --bulk 300
```

### Layout

```
packages/
  shared/   profile schema (zod), API types, default mappings, section level mapping
  server/   Fastify API, TestRail, Jira, Xray, Qase and Allure TestOps clients, CSV and XML reading, conversion, migration engine
  web/      React + Mantine UI
  mocks/    fake TestRail, Jira with Xray Cloud, Qase and Allure TestOps servers with synthetic projects
```

The conversion is split into a pure transformation (`server/src/convert`), which turns a TestRail case into a planned Allure TestOps case and backs both the preview and the migration, and a writer (`server/src/engine/writer.ts`) that applies the plan idempotently.

## License

[Apache License 2.0](LICENSE)
