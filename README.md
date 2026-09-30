# Allure TestOps Migration

A web tool that moves test cases from other test management systems into [Allure TestOps](https://qameta.io/). The first supported source is **TestRail**.

Everything is configured in the browser: connect both systems, pick the projects, map TestRail suites, section levels and fields to Allure TestOps using live data from both sides, preview a converted case, do a dry run, then migrate. Running the migration again updates the migrated cases instead of duplicating them.

## Quick start

You need Docker with Compose.

```bash
curl -O https://raw.githubusercontent.com/qameta/allure-testops-migration/main/docker-compose.yml
docker compose up -d
```

Open <http://localhost:8080>, create a profile and follow the steps.

Profiles and run logs are stored in the `migration-data` Docker volume. Use **Export to JSON** in the profile menu to move a profile to another machine and **Import** on the start page to load it. Credentials are left out of exports unless you tick *Include credentials*.

## What you need

- **TestRail**: the URL, a user email and an API key (*My Settings → API Keys*). The API must be enabled in *Administration → Site Settings → API*. Read access to the project is enough.
- **Allure TestOps**: the URL and an API token (*Your profile → API tokens*) of an account that can edit test cases in the target project. Listing users for owner mapping needs administrator rights; without them owners can still be typed in.

## The steps

1. **Connections.** TestRail and Allure TestOps credentials with a *Test connection* button. An optional TestRail session cookie is only needed when inline images fail to download on some TestRail versions. The TestRail API rate limit is set here too, see below.
2. **Projects.** The TestRail project, optionally some suites or a list of case ids for a trial run, and the target Allure TestOps project.
3. **Suites & sections.** The tool scans the section tree of the selected suites and shows how deep it is and which sections sit on each level. Each level gets its own Allure TestOps custom field (for example *Epic*, *Feature*, *Story*) instead of generic `Section1..N` fields. Levels deeper than the ones you map are either joined into the last mapped level (`Login / Errors`) or dropped. The suite name can go to its own field. The tool can create an Allure TestOps tree built from these fields.
4. **Fields.** Every TestRail field (system and custom) with its type, how often it is filled and example values from sampled cases. Choose a target for each: custom field, tags, layer, status, owner, links, issues, description, precondition, expected result, comment or scenario. Fields with a list of values (dropdowns, priorities, types, users, milestones, checkboxes) show all values with counts; each can be renamed, pointed at an existing Allure TestOps value or skipped. TestRail users are matched to Allure TestOps accounts by email automatically.
5. **Options.** Migration tag prefix, extra tag, link back to TestRail, text format (HTML detection), how plain text steps are split, attachments, shared steps, deleted cases and parallelism.
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
npm run dev:mocks    # TestRail on :4001, Allure TestOps on :4002
npm run dev:server   # API and UI on :8080 (UI from packages/web/dist)
npm run dev:web      # optional: UI with hot reload on :5173, proxies /api to :8080
```

Or everything in containers, built from the sources:

```bash
docker compose -f dev-compose.yml up --build
docker compose -f dev-compose.yml run --rm --build tests
```

Fake server credentials: TestRail user `demo@example.com` with API key `demo-api-key`, Allure TestOps token `demo-api-token`. Inside `dev-compose.yml` use `http://mocks:4001` and `http://mocks:4002` as URLs; from the host use `http://localhost:4001` and `http://localhost:4002`.

### Layout

```
packages/
  shared/   profile schema (zod), API types, default mappings, section level mapping
  server/   Fastify API, TestRail and Allure TestOps clients, conversion, migration engine
  web/      React + Mantine UI
  mocks/    fake TestRail and Allure TestOps servers with a synthetic project
```

The conversion is split into a pure transformation (`server/src/convert`), which turns a TestRail case into a planned Allure TestOps case and backs both the preview and the migration, and a writer (`server/src/engine/writer.ts`) that applies the plan idempotently.

## License

[Apache License 2.0](LICENSE)
