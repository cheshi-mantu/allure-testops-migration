import type { TestOpsConnection } from "@atm/shared";
import { HttpClient, HttpError, type Query } from "../http/httpClient.js";

/** Allure TestOps REST payloads, only the parts the migration uses. */

export interface ToPage<T> {
  content: T[];
  number: number;
  size: number;
  totalPages: number;
  totalElements: number;
}

export interface ToNamed {
  id: number;
  name: string;
}

export interface ToCustomField extends ToNamed {}

export interface ToCustomFieldValue {
  id?: number;
  name: string;
  customField: { id: number; name?: string };
}

export interface ToAccount {
  id?: number;
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ToTestCase {
  id: number;
  projectId: number;
  name: string;
  description?: string | null;
  precondition?: string | null;
  expectedResult?: string | null;
  deleted?: boolean;
}

export interface ToTestCasePatch {
  name?: string;
  description?: string;
  precondition?: string;
  expectedResult?: string;
  statusId?: number;
  workflowId?: number;
  testLayerId?: number;
  links?: { name: string; url: string; type?: string }[];
}

export interface ToAttachment {
  id: number;
  name: string;
  contentType?: string;
  contentLength?: number;
}

export interface ToComment {
  id: number;
  body: string;
}

export type ToScenarioStep =
  | { type: "body"; body: string; steps?: ToScenarioStep[]; expectedResultSteps?: ToScenarioStep[] }
  | { type: "expected_body"; body: string }
  | { type: "attachment"; attachmentId: number }
  | { type: "shared"; sharedStepId: number };

export interface ToNormalizedScenario {
  root?: { children?: number[] | null } | null;
}

export interface ToIntegration extends ToNamed {
  disabled?: boolean;
}

export interface ToTree extends ToNamed {
  fields?: ToNamed[];
}

const PAGE_SIZE = 100;

export class TestOpsClient {
  readonly http: HttpClient;

  constructor(connection: TestOpsConnection, http?: HttpClient) {
    this.http =
      http ??
      new HttpClient({
        baseUrl: connection.endpoint,
        insecureTls: connection.insecureTls,
        headers: { Authorization: `Api-Token ${connection.apiToken}` },
      });
  }

  get endpoint(): string {
    return this.http.baseUrl;
  }

  testCaseUrl(projectId: number, testCaseId: number): string {
    return `${this.http.baseUrl}project/${projectId}/test-cases/${testCaseId}`;
  }

  /** Reads all pages of a Spring style paged endpoint; also accepts plain arrays. */
  async all<T>(path: string, query: Query = {}, maxPages = 1000): Promise<T[]> {
    const items: T[] = [];
    for (let page = 0; page < maxPages; page++) {
      const response = await this.http.get<ToPage<T> | T[]>(path, { ...query, page, size: PAGE_SIZE });
      if (Array.isArray(response)) {
        return response;
      }
      items.push(...(response?.content ?? []));
      if (!response || page + 1 >= (response.totalPages ?? 0) || (response.content ?? []).length === 0) {
        break;
      }
    }
    return items;
  }

  // ------------------------------------------------------------------ account & projects

  me(): Promise<ToAccount> {
    return this.http.get<ToAccount>("api/uaa/account/me");
  }

  projects(): Promise<ToNamed[]> {
    return this.all<ToNamed>("api/rs/project");
  }

  project(projectId: number): Promise<ToNamed> {
    return this.http.get<ToNamed>(`api/rs/project/${projectId}`);
  }

  /** Users visible to the token. Needs administrator rights on most instances. */
  accounts(): Promise<ToAccount[]> {
    return this.all<ToAccount>("api/uaa/account", {}, 50);
  }

  // ------------------------------------------------------------------ reference data

  /** Custom fields bound to a project. */
  async projectCustomFields(projectId: number): Promise<ToCustomField[]> {
    const bindings = await this.all<{ id: number; name: string; customField?: ToCustomField | null }>(`api/rs/project/${projectId}/cf`);
    return bindings.map((binding) => ({
      id: binding.customField?.id ?? binding.id,
      name: binding.customField?.name ?? binding.name,
    }));
  }

  /** Global custom fields matching a query. */
  async suggestCustomFields(query: string): Promise<ToCustomField[]> {
    const page = await this.http.get<ToPage<ToCustomField>>("api/rs/cf/suggest", { query, page: 0, size: 500 });
    return page?.content ?? [];
  }

  customFieldValues(customFieldId: number): Promise<ToNamed[]> {
    return this.all<ToNamed>("api/rs/cfv", { customFieldId });
  }

  createCustomField(name: string): Promise<ToCustomField> {
    return this.http.json<ToCustomField>("POST", "api/rs/cf", { body: { name } });
  }

  addCustomFieldsToProject(projectId: number, ids: number[]): Promise<void> {
    return this.http.json<void>("POST", "api/rs/cfproject/add-to-project", { query: { projectId }, body: { ids } });
  }

  layers(): Promise<ToNamed[]> {
    return this.all<ToNamed>("api/rs/testlayer");
  }

  createLayer(name: string): Promise<ToNamed> {
    return this.http.json<ToNamed>("POST", "api/rs/testlayer", { body: { name } });
  }

  statuses(): Promise<ToNamed[]> {
    return this.all<ToNamed>("api/rs/status");
  }

  async integrations(projectId: number): Promise<ToIntegration[]> {
    const all = await this.all<ToIntegration>(`api/rs/integration/project/${projectId}`);
    return all.filter((integration) => !integration.disabled);
  }

  trees(projectId: number): Promise<ToTree[]> {
    return this.all<ToTree>("api/rs/tree", { projectId });
  }

  createTree(projectId: number, name: string, customFieldIds: number[]): Promise<ToTree> {
    return this.http.json<ToTree>("POST", "api/rs/tree", {
      body: { name, projectId, fields: customFieldIds.map((id) => ({ id })) },
    });
  }

  // ------------------------------------------------------------------ test cases

  async findTestCaseByTag(projectId: number, tag: string): Promise<ToTestCase | null> {
    const rql = `tag = "${tag.replace(/"/g, '\\"')}"`;
    const page = await this.http.get<ToPage<ToTestCase>>("api/rs/testcase/__search", { projectId, rql, page: 0, size: 2 });
    return page?.content?.[0] ?? null;
  }

  getTestCase(testCaseId: number): Promise<ToTestCase> {
    return this.http.get<ToTestCase>(`api/rs/testcase/${testCaseId}`);
  }

  createTestCase(projectId: number, name: string): Promise<ToTestCase> {
    return this.http.json<ToTestCase>("POST", "api/rs/testcase", { body: { projectId, name } });
  }

  updateTestCase(testCaseId: number, patch: ToTestCasePatch): Promise<ToTestCase> {
    return this.http.json<ToTestCase>("PATCH", `api/rs/testcase/${testCaseId}`, { body: patch });
  }

  setTags(testCaseId: number, tags: string[]): Promise<unknown> {
    return this.http.json("POST", `api/rs/testcase/${testCaseId}/tag`, { body: tags.map((name) => ({ name })) });
  }

  getCustomFieldValues(testCaseId: number): Promise<ToCustomFieldValue[]> {
    return this.http.get<ToCustomFieldValue[]>(`api/rs/testcase/${testCaseId}/cfv`);
  }

  setCustomFieldValues(testCaseId: number, values: ToCustomFieldValue[]): Promise<unknown> {
    return this.http.json("POST", `api/rs/testcase/${testCaseId}/cfv`, { body: values });
  }

  setIssues(testCaseId: number, issues: { name: string; integrationId: number }[]): Promise<unknown> {
    return this.http.json("POST", `api/rs/testcase/${testCaseId}/issue`, { body: issues });
  }

  /** Replaces the members of a test case. Role -1 is the owner role. */
  setMembers(testCaseId: number, members: { name: string; role: { id: number } }[]): Promise<unknown> {
    return this.http.json("POST", `api/rs/testcase/${testCaseId}/members`, { body: members });
  }

  /** Member roles such as Owner or Reviewer. */
  async roles(): Promise<ToNamed[]> {
    const response = await this.http.get<ToNamed[] | ToPage<ToNamed>>("api/rs/role");
    return Array.isArray(response) ? response : (response?.content ?? []);
  }

  comments(testCaseId: number): Promise<ToComment[]> {
    return this.all<ToComment>("api/rs/comment", { testCaseId });
  }

  addComment(testCaseId: number, body: string): Promise<ToComment> {
    return this.http.json<ToComment>("POST", "api/rs/comment", { body: { testCaseId, body } });
  }

  testCaseAttachments(testCaseId: number): Promise<ToAttachment[]> {
    return this.all<ToAttachment>("api/rs/testcase/attachment", { testCaseId });
  }

  async uploadTestCaseAttachment(testCaseId: number, name: string, data: Buffer, contentType: string): Promise<ToAttachment> {
    const result = await this.http.upload<ToAttachment[]>("api/rs/testcase/attachment", { testCaseId }, [
      { field: "file", name, data, contentType },
    ]);
    const attachment = result?.[0];
    if (!attachment) {
      throw new Error(`Allure TestOps did not return the uploaded attachment ${name}`);
    }
    return attachment;
  }

  async clearScenario(testCaseId: number): Promise<void> {
    const scenario = await this.http.get<ToNormalizedScenario>(`api/rs/testcase/${testCaseId}/step`);
    for (const stepId of scenario?.root?.children ?? []) {
      await this.http.json("DELETE", `api/rs/testcase/step/${stepId}`);
    }
  }

  setScenario(testCaseId: number, steps: ToScenarioStep[]): Promise<void> {
    return this.http.json<void>("POST", `api/rs/testcase/${testCaseId}/scenario`, { query: { v2: true }, body: { steps } });
  }

  // ------------------------------------------------------------------ shared steps

  async findSharedStep(projectId: number, name: string): Promise<ToNamed | null> {
    const page = await this.http.get<ToPage<ToNamed>>("api/rs/sharedstep", { projectId, search: name, archived: false, page: 0, size: 50 });
    return (page?.content ?? []).find((step) => step.name === name) ?? null;
  }

  createSharedStep(projectId: number, name: string): Promise<ToNamed> {
    return this.http.json<ToNamed>("POST", "api/rs/sharedstep", { body: { projectId, name } });
  }

  async clearSharedStepScenario(sharedStepId: number): Promise<void> {
    const scenario = await this.http.get<ToNormalizedScenario>(`api/rs/sharedstep/${sharedStepId}/step`);
    for (const stepId of scenario?.root?.children ?? []) {
      await this.http.json("DELETE", `api/rs/sharedstep/step/${stepId}`);
    }
  }

  setSharedStepScenario(sharedStepId: number, steps: ToScenarioStep[]): Promise<void> {
    return this.http.json<void>("POST", `api/rs/sharedstep/${sharedStepId}/scenario`, { body: { steps } });
  }

  sharedStepAttachments(sharedStepId: number): Promise<ToAttachment[]> {
    return this.all<ToAttachment>("api/rs/sharedstep/attachment", { sharedStepId });
  }

  async uploadSharedStepAttachment(sharedStepId: number, name: string, data: Buffer, contentType: string): Promise<ToAttachment> {
    const result = await this.http.upload<ToAttachment[]>("api/rs/sharedstep/attachment", { sharedStepId }, [
      { field: "file", name, data, contentType },
    ]);
    const attachment = result?.[0];
    if (!attachment) {
      throw new Error(`Allure TestOps did not return the uploaded attachment ${name}`);
    }
    return attachment;
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpError && error.status === 404;
}
