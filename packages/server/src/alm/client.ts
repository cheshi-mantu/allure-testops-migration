import type { AlmConnection } from "@atm/shared";
import { HttpClient, HttpError, type Query, type RetryInfo } from "../http/httpClient.js";
import type { AlmCollectionJson, AlmDomain, AlmEntityJson, AlmFieldDefinition, AlmRecord, AlmUser } from "./types.js";

/** Tests and steps per page; ALM caps pages at a size set by its administrator, 2000 by default. */
export const ALM_PAGE = 200;
/** Ids per query, so the address of a request stays short. */
const IDS_PER_QUERY = 50;

/** `https://alm.example.com`, `https://alm.example.com/qcbin` and `.../qcbin/` all mean the same server. */
export function almBase(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const at = trimmed.toLowerCase().indexOf("/qcbin");
  return `${at >= 0 ? trimmed.slice(0, at) : trimmed}/`;
}

/** `{parent-id[1 OR 2 OR 3]}`: the query syntax of the ALM REST API. */
export function almQuery(conditions: Record<string, (string | number)[] | string | number>): string {
  const parts = Object.entries(conditions).map(([field, value]) => {
    const values = Array.isArray(value) ? value : [value];
    const quoted = values.map((v) => (typeof v === "number" || /^[\w.-]+$/.test(v) ? String(v) : `"${String(v).replace(/"/g, '\\"')}"`));
    return `${field}[${quoted.join(" OR ")}]`;
  });
  return `{${parts.join(";")}}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export function toRecord(entity: AlmEntityJson): AlmRecord {
  const fields: Record<string, string[]> = {};
  for (const field of entity.Fields ?? entity.fields ?? []) {
    const name = field.Name ?? field.name;
    if (!name) {
      continue;
    }
    const values = (field.values ?? field.Values ?? [])
      .map((value) => value?.value ?? value?.Value ?? null)
      .filter((value): value is string => value !== null && value !== undefined && String(value) !== "")
      .map(String);
    if (values.length > 0) {
      fields[name] = values;
    }
  }
  return { type: entity.Type ?? entity.type ?? "", fields };
}

/** A value of an object whose keys ALM spells differently between versions: `List-Id`, `list-id`, `ListId`. */
function prop(object: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [key, value] of Object.entries(object)) {
    if (key.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted) {
      return value;
    }
  }
  return undefined;
}

/** Items under a key that holds one object or a list of them. */
function list(value: unknown, key: string): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  const inner = Array.isArray(value) ? value : prop(value as Record<string, unknown>, key);
  if (inner === undefined) {
    return [];
  }
  const items = Array.isArray(inner) ? inner : [inner];
  return items.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

const yes = (value: unknown) => value === true || /^(true|y|yes)$/i.test(String(value ?? ""));
const text = (value: unknown) => (value === undefined || value === null ? "" : String(value));

/** Receives the lines of the detailed log: requests, answers and what was read, never credentials. */
export type AlmTrace = (message: string) => void;

export interface AlmClientOptions {
  onRetry?: (info: RetryInfo) => void;
  pageSize?: number;
  trace?: AlmTrace;
}

/** Values of these fields are short codes that tell how ALM is set up; other values are never logged. */
const LOGGED_VALUES = new Set(["subtype-id", "status", "ref-type", "parent-type", "link-test", "attachment", "step-order", "has-params", "parent-id", "id", "exec-status", "template"]);

/** How a value looks, without the value: `text 23`, `html 512`, `number`. */
function kindOfValue(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return "number";
  }
  return /<\/?(html|body|div|p|br|span|font|img|table)\b/i.test(value) ? `html ${value.length}` : `text ${value.length}`;
}

/** The fields of an entity with the kind of their values. */
export function recordShape(record: AlmRecord): string {
  return Object.entries(record.fields)
    .map(([name, values]) => {
      const shown = LOGGED_VALUES.has(name) ? values.map((value) => JSON.stringify(value.slice(0, 40))).join("|") : values.map(kindOfValue).join("|");
      return `${name}=${shown}`;
    })
    .join(", ");
}

/** Keys of a JSON answer two levels deep, with the length of lists. */
function jsonShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    return `[${value.length}]${value.length > 0 && depth < 2 ? jsonShape(value[0], depth + 1) : ""}`;
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 2) {
      return `{${Object.keys(value).join(", ")}}`;
    }
    return `{${Object.entries(value).map(([key, inner]) => `${key}${inner !== null && typeof inner === "object" ? jsonShape(inner, depth + 1) : `:${typeof inner}`}`).join(", ")}}`;
  }
  return typeof value;
}

/** What went wrong, from the answer of ALM: its status and the start of its message, without tags. */
export function failureText(error: unknown): string {
  if (error instanceof HttpError) {
    const body = error.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
    return `${error.status === 0 ? "no answer" : `status ${error.status}`}${error.notApi ? " (a web page instead of API data)" : ""}${body ? `: ${body}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * OpenText ALM (Quality Center) REST API. A login opens a session kept in cookies; when ALM ends
 * the session, the client logs in again once and repeats the request.
 */
export class AlmClient {
  readonly http: HttpClient;
  private session: Promise<void> | null = null;
  private loggedIn = false;
  private readonly pageSize: number;
  private readonly trace: AlmTrace;
  /** Collections whose entity shape is already in the log. */
  private readonly shown = new Set<string>();

  constructor(
    private readonly connection: AlmConnection,
    options: AlmClientOptions = {},
  ) {
    this.pageSize = options.pageSize ?? ALM_PAGE;
    this.trace = options.trace ?? (() => undefined);
    this.http = new HttpClient({ baseUrl: almBase(connection.endpoint), insecureTls: connection.insecureTls, cookies: true, ...(options.onRetry ? { onRetry: options.onRetry } : {}) });
  }

  /** Runs one request and writes it to the detailed log: what was asked, how long it took, what came back. */
  private async traced<T>(label: string, request: () => Promise<T>, describe: (result: T) => string = () => "OK"): Promise<T> {
    const started = Date.now();
    try {
      const result = await request();
      this.trace(`${label} -> ${describe(result)} (${Date.now() - started} ms)`);
      return result;
    } catch (error) {
      this.trace(`${label} -> failed, ${failureText(error)} (${Date.now() - started} ms)`);
      throw error;
    }
  }

  private cookiesNow(): string {
    return `cookies now: ${this.http.cookieNames().join(", ") || "none"}`;
  }

  /** A short description of an answer; the fields of the first entity of every kind of collection. */
  private describe(path: string, answer: unknown): string {
    const page = answer as AlmCollectionJson | undefined;
    const entities = page?.entities ?? page?.Entities;
    if (!Array.isArray(entities)) {
      return `keys ${jsonShape(answer)}`;
    }
    const total = page?.TotalResults ?? page?.totalResults;
    let text = `${entities.length} entit${entities.length === 1 ? "y" : "ies"}, TotalResults ${total ?? "missing"}`;
    const kind = path.replace(/^.*\/projects\/[^/]+\//, "").replace(/\/\d+(?=\/|$)/g, "/{id}");
    if (entities.length > 0 && !this.shown.has(kind)) {
      this.shown.add(kind);
      const first = toRecord(entities[0]!);
      text += `; first entity: type "${first.type}", keys ${Object.keys(entities[0]!).join("/")}, fields ${recordShape(first)}`;
    }
    return text;
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  /** Older ALM versions do not know a resource, or a method on it. */
  private static missing(error: unknown): boolean {
    return error instanceof HttpError && (error.status === 404 || error.status === 405);
  }

  /** Logs in with the documented resources, falling back to those older ALM versions have. */
  private async authenticate(): Promise<void> {
    const { auth, username, password, clientId, secret } = this.connection;
    if (auth === "apiKey") {
      try {
        await this.traced("POST qcbin/rest/oauth2/login (API key)", () => this.http.json("POST", "qcbin/rest/oauth2/login", { body: { clientId, secret } }), () => this.cookiesNow());
        return;
      } catch (error) {
        if (!AlmClient.missing(error)) {
          throw error;
        }
      }
    }
    // An API key logs in as a user too: the client id as the user, the secret as the password.
    const user = auth === "apiKey" ? clientId : username;
    const pass = auth === "apiKey" ? secret : password;
    try {
      await this.traced(
        "POST qcbin/authentication-point/alm-authenticate",
        () => this.http.json("POST", "qcbin/authentication-point/alm-authenticate", { body: { "alm-authentication": { user, password: pass } } }),
        () => this.cookiesNow(),
      );
    } catch (error) {
      if (!AlmClient.missing(error)) {
        throw error;
      }
      const basic = Buffer.from(`${user}:${pass}`).toString("base64");
      await this.traced(
        "GET qcbin/authentication-point/authenticate (Basic authentication, older ALM)",
        () => this.http.json("GET", "qcbin/authentication-point/authenticate", { headers: { Authorization: `Basic ${basic}` } }),
        () => this.cookiesNow(),
      );
    }
  }

  private async openSession(): Promise<void> {
    this.http.clearCookies();
    this.http.removeHeader("X-XSRF-TOKEN");
    this.trace(`Logging in to ${this.http.baseUrl}qcbin with ${this.connection.auth === "apiKey" ? "an API key" : "a user name and password"}.`);
    await this.authenticate();
    // An API key login opens the session itself; a user login needs it opened.
    if (!this.http.cookie("QCSession")) {
      await this.traced("POST qcbin/rest/site-session", () => this.http.json("POST", "qcbin/rest/site-session"), () => this.cookiesNow());
    }
    // ALM asks for the token of the session with every request.
    const xsrf = this.http.cookie("XSRF-TOKEN");
    if (xsrf) {
      this.http.setHeader("X-XSRF-TOKEN", xsrf);
    }
    this.trace(`Logged in: ${xsrf ? "requests carry X-XSRF-TOKEN" : "ALM gave no XSRF-TOKEN cookie, requests go without X-XSRF-TOKEN"}; ${this.http.cookie("QCSession") ? "session cookie QCSession is set" : "no QCSession cookie"}.`);
    this.loggedIn = true;
  }

  /** Logs in, once for any number of requests waiting for it. */
  login(): Promise<void> {
    this.session ??= this.openSession().catch((error) => {
      this.session = null;
      throw error;
    });
    return this.session;
  }

  /** Ends the session and the login, so nothing stays open on the ALM server. */
  async logout(): Promise<void> {
    if (!this.loggedIn) {
      return;
    }
    this.loggedIn = false;
    this.session = null;
    try {
      await this.traced("DELETE qcbin/rest/site-session", () => this.http.json("DELETE", "qcbin/rest/site-session"));
      // GET is turned off for logging out since ALM 24.1; older versions may only know GET.
      await this.traced("POST qcbin/authentication-point/logout", () => this.http.json("POST", "qcbin/authentication-point/logout")).catch((error: unknown) => {
        if (!AlmClient.missing(error)) {
          throw error;
        }
        return this.traced("GET qcbin/authentication-point/logout", () => this.http.json("GET", "qcbin/authentication-point/logout"));
      });
    } catch {
      // The session ends by itself after a while.
    }
    this.http.clearCookies();
    this.http.removeHeader("X-XSRF-TOKEN");
  }

  /** Runs a request in a session; a request rejected because the session ended is repeated after a new login. */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    await this.login();
    const session = this.session;
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) {
        throw error;
      }
      if (this.session === session) {
        this.session = null;
      }
      this.trace("ALM answered 401: the session has ended. Logging in again and repeating the request.");
      await this.login();
      return request();
    }
  }

  get<T>(path: string, query?: Query): Promise<T> {
    const label = `GET ${decodeURIComponent(this.http.url(path, query).slice(this.http.baseUrl.length))}`;
    return this.call(() => this.traced(label, () => this.http.get<T>(path, query), (answer) => this.describe(path, answer)));
  }

  private projectPath(domain: string, project: string): string {
    return `qcbin/rest/domains/${encodeURIComponent(domain)}/projects/${encodeURIComponent(project)}/`;
  }

  /** Entities of a collection, page by page. */
  async *pages(domain: string, project: string, collection: string, query: Query = {}): AsyncGenerator<AlmRecord[]> {
    for (let start = 1; ; ) {
      const page = await this.get<AlmCollectionJson>(this.projectPath(domain, project) + collection, { ...query, "page-size": this.pageSize, "start-index": start });
      const entities = (page?.entities ?? page?.Entities ?? []).map(toRecord);
      if (entities.length > 0) {
        yield entities;
      }
      start += entities.length;
      const total = page?.TotalResults ?? page?.totalResults;
      if (entities.length === 0 || (total !== undefined && start > total)) {
        return;
      }
    }
  }

  async all(domain: string, project: string, collection: string, query: Query = {}): Promise<AlmRecord[]> {
    const result: AlmRecord[] = [];
    for await (const page of this.pages(domain, project, collection, query)) {
      result.push(...page);
    }
    return result;
  }

  /** Entities whose `field` is one of `ids`, a few dozen ids per request. */
  async byIds(domain: string, project: string, collection: string, field: string, ids: (string | number)[], extra: Record<string, string> = {}): Promise<AlmRecord[]> {
    const result: AlmRecord[] = [];
    for (const part of chunks([...new Set(ids.map(String))], IDS_PER_QUERY)) {
      result.push(...(await this.all(domain, project, collection, { query: almQuery({ [field]: part, ...extra }) })));
    }
    return result;
  }

  /** Domains with their projects the user can open. */
  async domains(): Promise<AlmDomain[]> {
    const answer = await this.get<unknown>("qcbin/rest/domains", { "include-projects-info": "y" });
    const domains = list(prop((answer ?? {}) as Record<string, unknown>, "Domains") ?? answer, "Domain");
    const result: AlmDomain[] = [];
    for (const domain of domains) {
      const name = text(prop(domain, "Name"));
      if (!name) {
        continue;
      }
      let projects = list(prop(domain, "Projects"), "Project").map((project) => text(prop(project, "Name"))).filter(Boolean);
      if (projects.length === 0) {
        const own = await this.get<unknown>(`qcbin/rest/domains/${encodeURIComponent(name)}/projects`).catch(() => null);
        projects = list(prop((own ?? {}) as Record<string, unknown>, "Projects") ?? own, "Project").map((project) => text(prop(project, "Name"))).filter(Boolean);
      }
      result.push({ name, projects });
    }
    return result;
  }

  async testCount(domain: string, project: string): Promise<number> {
    const page = await this.get<AlmCollectionJson>(this.projectPath(domain, project) + "tests", { "page-size": 1, "start-index": 1 });
    return page?.TotalResults ?? page?.totalResults ?? 0;
  }

  testFolders(domain: string, project: string): Promise<AlmRecord[]> {
    return this.all(domain, project, "test-folders");
  }

  /** Tests of the project, or of the given folders only, in the order of their ids. */
  tests(domain: string, project: string, folderIds: number[] | null): AsyncGenerator<AlmRecord[]> {
    const order = { "order-by": "{id[ASC]}" };
    if (folderIds === null) {
      return this.pages(domain, project, "tests", order);
    }
    const self = this;
    return (async function* () {
      for (const part of chunks(folderIds, IDS_PER_QUERY)) {
        yield* self.pages(domain, project, "tests", { ...order, query: almQuery({ "parent-id": part }) });
      }
    })();
  }

  testsByIds(domain: string, project: string, ids: number[]): Promise<AlmRecord[]> {
    return this.byIds(domain, project, "tests", "id", ids);
  }

  designSteps(domain: string, project: string, testIds: number[]): Promise<AlmRecord[]> {
    return this.byIds(domain, project, "design-steps", "parent-id", testIds);
  }

  testParameters(domain: string, project: string, testIds: number[]): Promise<AlmRecord[]> {
    return this.byIds(domain, project, "test-parameters", "parent-id", testIds, { "parent-type": "test" });
  }

  /** Attachments of a test (`tests`) or of a design step (`design-steps`). */
  attachments(domain: string, project: string, owner: "tests" | "design-steps", id: number | string): Promise<AlmRecord[]> {
    return this.all(domain, project, `${owner}/${id}/attachments`);
  }

  attachmentContent(domain: string, project: string, owner: "tests" | "design-steps", id: number | string, name: string): Promise<{ data: Buffer; contentType: string | null; fileName: string | null }> {
    return this.call(() =>
      this.traced(
        `GET ${owner}/${id}/attachments/${name}`,
        () => this.http.bytes(`${this.projectPath(domain, project)}${owner}/${id}/attachments/${encodeURIComponent(name)}`, { Accept: "application/octet-stream" }),
        (file) => `${file.data.length} bytes, ${file.contentType ?? "no content type"}${file.fileName ? `, file name ${file.fileName}` : ""}`,
      ),
    );
  }

  /** Fields of the test entity with the labels the project gave them. */
  async testFields(domain: string, project: string): Promise<AlmFieldDefinition[]> {
    const answer = await this.get<unknown>(this.projectPath(domain, project) + "customization/entities/test/fields");
    const fields = list(prop((answer ?? {}) as Record<string, unknown>, "Fields") ?? answer, "Field");
    return fields
      .map((field) => ({
        name: text(prop(field, "Name")),
        label: text(prop(field, "Label")) || text(prop(field, "Name")),
        type: text(prop(field, "Type")),
        system: yes(prop(field, "System")),
        active: prop(field, "Active") === undefined ? true : yes(prop(field, "Active")),
        multiValue: yes(prop(field, "SupportsMultivalue") ?? prop(field, "Supports-Multivalue")),
      }))
      .filter((field) => field.name);
  }

  async users(domain: string, project: string): Promise<AlmUser[]> {
    const answer = await this.get<unknown>(this.projectPath(domain, project) + "customization/users");
    return list(prop((answer ?? {}) as Record<string, unknown>, "Users") ?? answer, "User")
      .map((user) => ({ name: text(prop(user, "Name")), fullName: text(prop(user, "FullName")) || null, email: text(prop(user, "email")) || null }))
      .filter((user) => user.name);
  }
}
