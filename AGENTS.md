# AGENTS.md

Guide for coding agents (and people) who extend this tool with a new source, or build another migration into Allure TestOps from a different test management system (TMS). It covers the ground rules, the technology, the architecture, the Allure TestOps REST API as a migration uses it, and how to test.

## Ground rules

- The repository is public. Allure TestOps is a closed source commercial product: rely only on the behaviour of its public REST API. In code, comments, docs and UI mention only public API paths and fields. No guesses about its database, internal services, server classes or internal logic. Do not use endpoints hidden from the API documentation, even if the web application calls them.
- Secrets (API tokens, passwords, keys, session cookies) stay on the server of the tool. The browser gets a mask (`********`); profile exports leave secrets out unless the user opts in.
- Every problem a user can meet must say what happened, why, and where to fix it (a link to the step and field). Raw server answers go to a `detail` for support, never instead of an explanation.
- UI and log texts: plain English, short sentences, no em dashes. Say "Line 12" for file records and the source id (for example "C123") for cases from a TMS, so people can find the record.
- Migration must be safe to run again: a rerun updates what an earlier run created and never duplicates it.

## Technology

| Part | Choice | Why |
|---|---|---|
| Runtime | Node.js 22.12+, TypeScript, ES modules | One language for server, UI and shared types |
| Monorepo | npm workspaces: `shared`, `server`, `web`, `mocks` | Shared schema and types without publishing packages |
| Validation | zod 4 (`packages/shared`) | One schema for profiles, defaults, import and export |
| Server | Fastify 5, `@fastify/static` | Small, fast, serves the API and the built UI |
| HTTP client | undici `fetch` behind `server/src/http/httpClient.ts` | Retries, `Retry-After`, timeouts, optional insecure TLS, shared rate limiter |
| HTML to Markdown | turndown | Source rich text becomes Allure TestOps Markdown |
| UI | React 19, Mantine 9, TanStack Query 5, react-router 7, Vite | Forms and tables with little code, cached server state |
| Tests | Vitest 5, fake servers in `packages/mocks` | Runs TypeScript and ESM directly; end-to-end runs without real servers |
| Delivery | Docker image (`node:22-alpine`), data in a volume | One command for end users, nothing to install |

Commands (run from the repository root; Vitest aliases the workspace packages to their sources, from a package folder it would pick stale builds):

```bash
npm install
npm run build        # shared, server, web, mocks
npm run typecheck
npm test             # unit and end-to-end tests against the fake servers
npm run dev:mocks    # fake TestRail :4001, fake Allure TestOps :4002 (ports via TESTRAIL_PORT, TESTOPS_PORT)
npm run dev:server   # API and UI on :8080 (PORT), data in ./.data (DATA_DIR)
npm run dev:web      # optional UI with hot reload on :5173
```

Containers: `docker compose -f dev-compose.yml up --build` (app and fake servers), `docker compose -f dev-compose.yml run --rm --build tests` (tests). End users run `docker-compose.yml` with the published image. The release workflow publishes the image only when a GitHub release is published.

## Repository map

```
packages/
  shared/src/profile.ts     profile schema: connections, scope, structure, field mappings, options, secret paths
  shared/src/api.ts         API types: discovery, PlannedCase, PlannedStep, run summary, problems
  shared/src/structure.ts   section path to per-level custom fields
  shared/src/runs.ts        what a run used (source, project, tag prefix) and how it differs from the profile
  server/src/index.ts       Fastify app, static UI, DATA_DIR
  server/src/routes/        REST API for the UI
  server/src/storage/       profiles, uploaded files, runs and logs as JSON files under DATA_DIR
  server/src/http/          HttpClient, RateLimiter
  server/src/testops/       Allure TestOps client and project discovery
  server/src/testrail/      TestRail client, discovery, field and section handling
  server/src/xray/          Xray Cloud (GraphQL) and Jira Cloud (REST v3) clients, field catalog, wiki markup, transform, discovery
  server/src/csv/           CSV reading, column suggestions, grouping rows into cases, step parsing, transform
  server/src/convert/       TestRail case to PlannedCase (pure), text and markup conversion
  server/src/engine/        sources, runner (dry run and migration), writer, target lookups, problems
  web/src/pages/steps/      one React component per wizard step
  mocks/src/                fake TestRail and Allure TestOps with failure injection
```

## How a migration works

1. **Profile.** Everything the user configures is one zod-validated `Profile`: source type, connections, scope, structure mapping, field mappings, options. It is saved under `DATA_DIR/profiles` and can be exported and imported as JSON.
2. **Discovery.** The tool reads the source (fields with filled counts, examples and distinct values; sections; sample cases) and the target project (custom fields, layers, statuses, roles, users, integrations, trees). Mapping screens show both, so users map real values, not guesses.
3. **Transform.** A pure function turns one source record into a `PlannedCase` plus `notes` (things that will not migrate as the user may expect). The same function backs the Preview step, the dry run and the migration, so what the user previews is what gets written.
4. **Dry run.** Converts every case without writing, checks the target (fields and values that will be created, missing statuses, users and roles) and lists the problems with fix links.
5. **Migration.** Prepares structure custom fields and the tree, then writes cases in parallel (`options.concurrency`, 1 to 16, default 2). Cases that failed on the server side get one more attempt at the end, one at a time. A last pass rewrites cases whose text links to cases migrated later.
6. **Run record.** Each run stores a summary (counters, phase, problems, the source, project and tag prefix it used) and a log with source ids and target ids, under `DATA_DIR/runs/<profileId>`.

### Contracts a source implements

`server/src/engine/sources.ts`:

```ts
interface SourceCase { key: string; title: string; line?: number }  // key: stable source id; line: for file sources
interface PreparedSource<C extends SourceCase> {
  name: string;
  assets: SourceAssets;                     // attachment downloads and shared steps; noAssets for plain files
  readCases(log, isCancelled): Promise<C[]>;
  transform(testCase: C): { planned: PlannedCase; linkedCaseIds: string[] };
  testrail: TestRailClient | null;          // a source client, for rate limit reporting
}
```

`PlannedCase` (`shared/src/api.ts`) is the source-neutral description of one Allure TestOps test case: `sourceId`, `sourceUrl`, optional `allureId` (update this existing case), `name`, `description`, `precondition`, `expectedResult` (Markdown), `tags`, `customFields` (field name to values), `layer`, `status`, `owner`, `members` (`{ name, role }`), `links`, `issues` (`{ key, integrationId }`), `comments`, `attachments`, `scenario` (`PlannedStep[]`: steps with nested steps, data, expected result and attachments, or a shared step reference), `notes`.

### Adding a new source (for example Zephyr, qTest, TestLink, Azure Test Plans)

The Xray Cloud source (`server/src/xray`) is the most complete example: two systems behind one source (Jira for the issue, Xray for the test details), a field catalog that turns every attribute into a mappable field with values and examples, conversion of the source markup, attachments from two places, and called tests as shared steps.

1. `shared/src/profile.ts`: add the source to `SOURCES`, a connection schema (mark secret fields in `SECRET_PATHS`), a scope schema, and default options in `shared/src/defaults.ts` (for example a migration tag prefix named after the source).
2. `server/src/<source>/client.ts`: a client on top of `HttpClient` with the source's paging, auth and a `RateLimiter` if the source limits requests. Report waits through `onRetry` so long pauses show in the run log.
3. `server/src/<source>/discovery.ts`: return `SourceDiscovery` (fields with `filledCount`, `examples`, `options` or distinct values, suggested targets; structure; warnings). Suggest mappings, but never guess silently: the user must be able to see and change every suggestion.
4. A pure transform to `PlannedCase` with unit tests on real-world shaped samples. Put anything lossy into `notes` with a `code`, a one-line `summary`, a `hint` and a `fix` link.
5. `SourceAssets` for attachments (download by source id) and shared steps, if the source has them.
6. Register the source in `prepareSource` (`server/src/engine/sources.ts`), add its wizard steps in `web/src/pages/ProfilePage.tsx`, extend `explain` and `serviceOf` in `server/src/engine/problems.ts` for its error messages.
7. A fake server in `packages/mocks` with a synthetic project, and an end-to-end test that migrates it into the fake Allure TestOps and runs it twice (the second run must only update).

## Allure TestOps REST API for migrations

All paths are relative to the instance URL, for example `https://testops.example.com/`.

### Access and conventions

- Auth: header `Authorization: Api-Token <token>` on every request. Check the token with `GET api/uaa/account/me`. The token's user needs rights to edit test cases in the target project; creating custom fields and trees may need project or instance administrator rights; listing users usually needs administrator rights (the tool then lets users type names).
- Paging: Spring style. Query `page` (0-based), `size`, optional `sort` (`id,asc`); answer `{ content, number, size, totalPages, totalElements }`. Some endpoints return a plain array: accept both.
- JSON in and out. Attachments are `multipart/form-data` with the file in the field `file`.
- Test case link for people: `<instance>/project/{projectId}/test-cases/{testCaseId}`.

### Reading the target project (discovery)

| What | Request |
|---|---|
| Projects | `GET api/rs/project`, `GET api/rs/project/{id}` |
| Custom fields bound to the project | `GET api/rs/project/{projectId}/cf` (items carry `customField { id, name }`) |
| All custom fields | `GET api/rs/cf/suggest?query=&page=0&size=500` |
| Values of a custom field | `GET api/rs/cfv/suggest?customFieldId=&projectId=&query=&size=` (look values up by query; global fields can have many thousands) |
| Test layers | `GET api/rs/testlayer` |
| Statuses | `GET api/rs/status` |
| Member roles | `GET api/rs/role` |
| Users | `GET api/uaa/account` (`username`, `email`, `firstName`, `lastName`) |
| Issue tracker integrations | `GET api/rs/integration/project/{projectId}` (skip `disabled`) |
| Trees | `GET api/rs/tree?projectId=` |

### Writing one test case

The order matters: the case must become findable (tags) before anything else can fail.

1. **Find.** If the source maps to an existing Allure TestOps id, `GET api/rs/testcase/{id}` and check `projectId`. Otherwise find by the migration tag: `GET api/rs/testcase/__search?projectId=&rql=tag = "<prefix>:<sourceId>"&page=0&size=2` (escape quotes inside the value).
2. **Create** when not found: `POST api/rs/testcase` with `{ "projectId": 1, "name": "Login works" }`. Keep the returned id in memory for the rest of the run.
3. **Tags:** `POST api/rs/testcase/{id}/tag` with `[{ "name": "<prefix>:<sourceId>" }, { "name": "smoke" }]`. This replaces the list, so always send the migration tag.
4. **Fields:** `PATCH api/rs/testcase/{id}` with any of `name`, `description`, `precondition`, `expectedResult`, `statusId`, `testLayerId`, `links: [{ "name": "...", "url": "https://..." }]`.
5. **Custom fields:** `POST api/rs/testcase/{id}/cfv` with `[{ "name": "Checkout", "customField": { "id": 12 } }]`. This replaces all values of the case: read `GET api/rs/testcase/{id}/cfv` first and send back the values of fields the migration does not manage.
6. **Issues:** `POST api/rs/testcase/{id}/issue` with `[{ "name": "ABC-123", "integrationId": 1 }]`. Only with an enabled integration of the project.
7. **Test keys** (keys of the case in a test management system connected through an integration): `GET api/rs/testcase/{id}/testkey`, then `POST api/rs/testcase/{id}/testkey` with `[{ "name": "CALC-12", "integrationId": 2 }]`. This replaces all test keys of the case: send back the keys of other integrations.
8. **Owner and members:** `POST api/rs/testcase/{id}/members` with `[{ "name": "jane", "role": { "id": -1 } }, { "name": "sam", "role": { "id": 2 } }]`. Role id `-1` is the owner. This replaces the list. An unknown user fails the whole request: on failure, retry adding members one by one to keep the valid ones and report the rest.
9. **Comments:** `GET api/rs/comment?testCaseId=` then `POST api/rs/comment` with `{ "testCaseId": 1, "body": "..." }` only for bodies not present yet.
10. **Attachments:** `GET api/rs/testcase/attachment?testCaseId=` then `POST api/rs/testcase/attachment?testCaseId=` (multipart, field `file`), only for file names not present yet. The answer is an array with the uploaded attachment.
11. **Scenario:** remove the old steps (`GET api/rs/testcase/{id}/step`, then `DELETE api/rs/testcase/step/{stepId}` for each id in `root.children`), then `POST api/rs/testcase/{id}/scenario?v2=true` with `{ "steps": [...] }`.

Scenario step objects:

```json
{ "steps": [
  { "type": "body", "body": "Open the login page",
    "steps": [ { "type": "body", "body": "Nested step" }, { "type": "attachment", "attachmentId": 42 } ],
    "expectedResultSteps": [ { "type": "expected_body", "body": "The form is shown" } ] },
  { "type": "shared", "sharedStepId": 7 }
] }
```

Step bodies are plain text; `description`, `precondition`, `expectedResult` and comments are Markdown. An inline image in Markdown points at an uploaded attachment: `![name](/api/rs/testcase/attachment/{attachmentId}/content)`. Upload attachments before writing text and steps that refer to them.

### Shared steps

- Find: `GET api/rs/sharedstep?projectId=&search=<name>&archived=false`, compare names exactly. Create: `POST api/rs/sharedstep` with `{ "projectId": 1, "name": "..." }`.
- Steps: `GET api/rs/sharedstep/{id}/step`, `DELETE api/rs/sharedstep/step/{stepId}`, `POST api/rs/sharedstep/{id}/scenario` with `{ "steps": [...] }`. Attachments: `api/rs/sharedstep/attachment?sharedStepId=`.
- Give migrated shared steps a stable name that includes the source id (this tool uses `<title> [<sourceId>]`), so reruns reuse them. Migrate each shared step once per run and cache the result.

### Custom fields, layers, statuses, roles, trees

- Custom fields are instance-wide; a project uses the ones bound to it. To use a field: find it in the project, else find it globally (`api/rs/cf/suggest`), else create it (`POST api/rs/cf` with `{ "name": "Feature" }`), then bind it: `POST api/rs/cfproject/add-to-project?projectId=` with `{ "ids": [12] }`. Cache lookups and share in-flight requests so parallel cases do not create the same field twice.
- New values are created by writing them to a case. A field can be limited to a fixed list of values or to one value per case; then writing gives 400. Offer a value mapping (source value to target value or skip).
- Layers can be created: `POST api/rs/testlayer` with `{ "name": "API" }` (compare names case-insensitively).
- Statuses belong to workflows and roles are configured on the instance: do not create them, map source values to existing names and report missing ones.
- A tree that groups cases by custom fields: `POST api/rs/tree` with `{ "name": "...", "projectId": 1, "fields": [{ "id": 12 }, { "id": 13 }] }`. Keep an existing tree with the same name as is.
- Source folder or section hierarchies map well to one custom field per level (for example Epic, Feature, Story) plus a tree over those fields. Let the user choose what happens to levels deeper than the mapped ones (join into the last field, or drop).

### Reruns and idempotency

- Mark every migrated case with the tag `<prefix>:<sourceId>`. The prefix must be required and per source (two files numbered 1, 2, 3 must not collide in one project). The prefix `testrail` matches the earlier TestRail migration tool, so its cases are updated, not duplicated.
- Find before create. After a failed step, reuse the id created earlier in the run instead of searching by tag (the tag may not be set yet).
- Replace lists that the API replaces (tags, members, scenario); merge what belongs to the user (custom field values of unmanaged fields); add only missing comments and attachments.
- Text that links to other source cases can be resolved only after those cases exist: collect such cases and rewrite them in a last pass.

### Errors and load

- 400: the request was refused because of the data (locked custom field values, unknown users, invalid issue keys). Explain per operation and point to the mapping that produced the value.
- 401: wrong, expired or revoked token. 403: the user lacks a permission for this operation in this project. 404 on a case: it was deleted meanwhile.
- 429 and 502, 503, 504: repeat with backoff, honour `Retry-After`.
- 500 `An unexpected error occurred` happens under load on any operation, including creating cases. Reads can be repeated. Writes must not be repeated blindly, the server may have applied them: find the object again (by id or tag), then update.
- Sometimes an API request is answered with status 200 and the HTML of the web application (`Content-Type: text/html`) instead of JSON. The request did not reach the API (the server or a proxy in front of it could not route it, usually under load or during a restart). It is safe to repeat. Do not report it as a data problem.
- Keep parallelism modest (this tool defaults to 2 cases at a time, each case is several sequential requests). Retry cases that failed on the server side once at the end of the run, sequentially, after a pause.

## UX that users expect from this tool

- A wizard with a done mark per step: connections (with a check button), source scope, target project, structure, field mapping, options, preview, run.
- Mappings built from live data of both systems, with examples, filled counts and value tables; unknown targets are marked "new" (will be created) or "add" (exists, will be bound to the project).
- A preview of any single case exactly as it will be written.
- A dry run before writing; a migration that can be cancelled and repeated; a phase line that says what is happening now.
- A problems list grouped by cause, with counts, affected records and a fix button; a downloadable plain text log.
- Required settings block the next step and the run with a message in red, instead of silent defaults.
- Runs remember the source, project and tag prefix they used; runs made with other settings are shown as such.

## Testing

- Unit tests next to the code (`*.test.ts`), end-to-end tests in `packages/server/test`. Run everything with `npm test` from the root.
- `createTestOpsMock()` from `@atm/mocks` serves the subset of the Allure TestOps API listed above and keeps its state in memory (`state.testCases`, `state.customFields`, ...). Options: `latencyMs`, `rejectedCustomFieldValues` (400 for these values), `failures` (answer matching requests with 500 or with an HTML page a given number of times).
- An end-to-end test for a source should: migrate a synthetic project, check the written cases field by field, run again and expect only updates, and run once with injected failures expecting no duplicates.
- `createXrayMock()` serves Jira Cloud REST v3 and the Xray Cloud GraphQL API on one port, with a project of Manual, Cucumber and Generic tests, a called test, folders, preconditions, sets, plans, comments, links and attachments. Search pages hold two issues, so paging is always exercised.
- Test the UI against the fake servers (`npm run dev:mocks` and `npm run dev:server`): fake TestRail user `demo@example.com` with API key `demo-api-key`, fake Allure TestOps token `demo-api-token`, fake Jira and Xray on port 4003 (`demo@example.com` / `demo-jira-token`, Xray `demo-client-id` / `demo-client-secret`).
