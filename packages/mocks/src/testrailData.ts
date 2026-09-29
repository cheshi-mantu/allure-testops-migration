/** Synthetic TestRail project used by the fake TestRail server. All names and people are made up. */

export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

export const users = [
  { id: 1, name: "Alex Admin", email: "alex@example.com", is_active: true },
  { id: 2, name: "Jane Doe", email: "jane@example.com", is_active: true },
  { id: 3, name: "Sam Tester", email: "sam@example.com", is_active: true },
];

export const priorities = [
  { id: 1, name: "Low", short_name: "Low", priority: 1, is_default: false },
  { id: 2, name: "Medium", short_name: "Medium", priority: 2, is_default: true },
  { id: 3, name: "High", short_name: "High", priority: 3, is_default: false },
  { id: 4, name: "Critical", short_name: "Critical", priority: 4, is_default: false },
];

export const caseTypes = [
  { id: 1, name: "Acceptance", is_default: false },
  { id: 6, name: "Functional", is_default: true },
  { id: 9, name: "Regression", is_default: false },
  { id: 11, name: "Smoke & Sanity", is_default: false },
];

export const templates = [
  { id: 1, name: "Test Case (Text)" },
  { id: 2, name: "Test Case (Steps)" },
  { id: 3, name: "Exploratory Session" },
];

export const milestones = [
  { id: 1, name: "Release 1.0", milestones: [{ id: 3, name: "Sprint 1" }] },
  { id: 2, name: "Release 1.1", milestones: [] },
];

const global = [{ context: { is_global: true, project_ids: null }, options: { is_required: false } }];
const forProject = (items?: string) => [{ context: { is_global: false, project_ids: [1] }, options: { is_required: false, items } }];

export const caseFields = [
  { id: 1, system_name: "custom_preconds", name: "preconds", label: "Preconditions", type_id: 3, is_active: true, configs: global },
  { id: 2, system_name: "custom_steps", name: "steps", label: "Steps", type_id: 3, is_active: true, configs: global },
  { id: 3, system_name: "custom_expected", name: "expected", label: "Expected Result", type_id: 3, is_active: true, configs: global },
  { id: 4, system_name: "custom_steps_separated", name: "steps_separated", label: "Steps (separated)", type_id: 10, is_active: true, configs: global },
  { id: 5, system_name: "custom_mission", name: "mission", label: "Mission", type_id: 3, is_active: true, configs: global },
  { id: 6, system_name: "custom_automation_type", name: "automation_type", label: "Automation Type", type_id: 6, is_active: true, configs: forProject("0, None\n1, Selenium\n2, Cypress") },
  { id: 7, system_name: "custom_platforms", name: "platforms", label: "Platforms", type_id: 12, is_active: true, configs: forProject("1, Web\n2, iOS\n3, Android") },
  { id: 8, system_name: "custom_ready", name: "ready", label: "Ready for review", type_id: 5, is_active: true, configs: forProject() },
  { id: 9, system_name: "custom_reviewer", name: "reviewer", label: "Reviewer", type_id: 7, is_active: true, configs: forProject() },
  { id: 10, system_name: "custom_spec_url", name: "spec_url", label: "Specification", type_id: 4, is_active: true, configs: forProject() },
  { id: 11, system_name: "custom_legacy", name: "legacy", label: "Legacy field", type_id: 1, is_active: false, configs: global },
  { id: 12, system_name: "custom_other_team", name: "other_team", label: "Other team field", type_id: 1, is_active: true, configs: [{ context: { is_global: false, project_ids: [42] } }] },
];

export const project = { id: 1, name: "Web Shop", suite_mode: 3, is_completed: false, announcement: null, url: "" };

export const suites = [
  { id: 1, name: "Web shop", description: "Customer facing web application.", project_id: 1 },
  { id: 2, name: "Mobile app", description: null, project_id: 1 },
];

interface Section {
  id: number;
  suite_id: number;
  name: string;
  description: string | null;
  parent_id: number | null;
  depth: number;
  display_order: number;
}

const sectionList: Section[] = [];
function addSection(id: number, suite: number, name: string, parent: number | null, description: string | null = null) {
  const depth = parent === null ? 0 : sectionList.find((s) => s.id === parent)!.depth + 1;
  sectionList.push({ id, suite_id: suite, name, description, parent_id: parent, depth, display_order: id });
}
addSection(1, 1, "Storefront", null, "Everything a visitor sees before logging in.");
addSection(2, 1, "Catalog", 1);
addSection(3, 1, "Search", 2);
addSection(4, 1, "Filters", 3, "Faceted search filters.");
addSection(5, 1, "Checkout", 1);
addSection(6, 1, "Payment", 5);
addSection(7, 1, "Account", null);
addSection(8, 1, "Login", 7);
addSection(9, 1, "Profile", 7);
addSection(10, 1, "Addresses", 9);
addSection(20, 2, "iOS", null);
addSection(21, 2, "Onboarding", 20);
addSection(22, 2, "Android", null);
addSection(23, 2, "Onboarding", 22);
addSection(24, 2, "Permissions", 23);
export const sections = sectionList;

export const sharedSteps = [
  {
    id: 1,
    title: "Log in as customer",
    project_id: 1,
    custom_steps_separated: [
      { content: "Open the login page", expected: "The login form is shown", additional_info: null, refs: null },
      { content: "Enter valid credentials and submit", expected: "The account page is open", additional_info: "User: customer@example.com", refs: null },
    ],
  },
  {
    id: 2,
    title: "Add a product to the cart",
    project_id: 1,
    custom_steps_separated: [
      { content: "Open any product page ![](index.php?/attachments/get/2001)", expected: "Product details are shown", additional_info: null, refs: null },
      { content: "Click **Add to cart**", expected: "The cart counter increases", additional_info: null, refs: null },
    ],
  },
];

export interface Attachment {
  id: string;
  data_id: number;
  name: string;
  filename: string;
  filetype: string;
  size: number;
  entity_id: string;
}

export const attachments: Attachment[] = [];
function attachment(dataId: number, caseId: number, name: string): string {
  const id = `a${dataId}-${caseId}`;
  attachments.push({ id, data_id: dataId, name, filename: name, filetype: "png", size: PNG_1PX.length, entity_id: String(caseId) });
  return id;
}
attachments.push({ id: "2001", data_id: 2001, name: "product.png", filename: "product.png", filetype: "png", size: PNG_1PX.length, entity_id: "" });

const leafSections = [4, 6, 8, 10, 3, 5, 21, 24, 23, 2];
const titles = [
  "Filter products by price",
  "Pay with a saved card",
  "Log in with valid credentials",
  "Add a delivery address",
  "Search by product name",
  "Checkout as a guest",
  "Complete onboarding on iOS",
  "Grant camera permission on Android",
  "Skip onboarding on Android",
  "Browse catalog categories",
];

export interface Case {
  id: number;
  title: string;
  section_id: number;
  suite_id: number;
  template_id: number;
  type_id: number;
  priority_id: number;
  milestone_id: number | null;
  refs: string | null;
  created_by: number;
  created_on: number;
  updated_by: number;
  updated_on: number;
  estimate: string | null;
  is_deleted: number;
  [field: string]: unknown;
}

export const cases: Case[] = [];
for (let i = 0; i < 36; i++) {
  const id = 1001 + i;
  const sectionId = leafSections[i % leafSections.length]!;
  const suiteId = sectionList.find((s) => s.id === sectionId)!.suite_id;
  const template = (i % 3) + 1;
  const variant = Math.floor(i / leafSections.length);
  const testCase: Case = {
    id,
    title: `${titles[i % titles.length]}${variant > 0 ? ` (variant ${variant + 1})` : ""}`,
    section_id: sectionId,
    suite_id: suiteId,
    template_id: template,
    type_id: caseTypes[i % caseTypes.length]!.id,
    priority_id: (i % 4) + 1,
    milestone_id: i % 5 === 0 ? 1 : i % 5 === 1 ? 3 : null,
    refs: i % 4 === 0 ? `SHOP-${100 + i}, SHOP-${200 + i}` : i % 4 === 1 ? `SHOP-${100 + i}` : null,
    created_by: (i % 3) + 1,
    created_on: 1_700_000_000 + i * 3600,
    updated_by: 1,
    updated_on: 1_700_100_000 + i * 3600,
    estimate: i % 6 === 0 ? "30m" : null,
    is_deleted: 0,
    custom_preconds: null,
    custom_steps: null,
    custom_expected: null,
    custom_steps_separated: null,
    custom_mission: null,
    custom_automation_type: i % 3,
    custom_platforms: suiteId === 2 ? [i % 2 === 0 ? 2 : 3] : [1],
    custom_ready: i % 2 === 0,
    custom_reviewer: i % 4 === 2 ? 3 : null,
    custom_spec_url: i % 5 === 3 ? `https://wiki.example.com/spec/${id}` : null,
  };
  if (template === 1) {
    testCase.custom_preconds = i % 2 === 0 ? "The customer has an account.\n\n|||:Field|:Value\n|| Email | customer@example.com\n|| Password | secret" : "<p>The shop is <strong>open</strong>.</p><p><img src=\"index.php?/attachments/get/" + attachment(3000 + i, id, `screen-${id}.png`) + "\" /></p>";
    testCase.custom_steps = "1. Open the shop\n2. Go to the section under test\n3. Perform the action\n![](index.php?/attachments/get/" + attachment(4000 + i, id, `step-${id}.png`) + ")";
    testCase.custom_expected = `The action succeeds. See also [related case](https://testrail.example/index.php?/cases/view/${1001 + ((i + 1) % 36)}).`;
  } else if (template === 2) {
    testCase.custom_preconds = "Test data is prepared.";
    const steps: unknown[] = [];
    if (i % 2 === 1) {
      steps.push(...sharedSteps[0]!.custom_steps_separated.map((s) => ({ ...s, shared_step_id: 1 })));
    }
    steps.push(
      { content: "Open the page under test", expected: "The page is shown", additional_info: null, refs: null, shared_step_id: null },
      {
        content: "Fill in the form",
        expected: "The form accepts the values ![](index.php?/attachments/get/" + attachment(5000 + i, id, `form-${id}.png`) + ")",
        additional_info: "|||:Input|:Value\n|| Name | Jane\n|| City | Springfield",
        refs: null,
        shared_step_id: null,
      },
    );
    if (i % 4 === 0) {
      steps.push(...sharedSteps[1]!.custom_steps_separated.map((s) => ({ ...s, shared_step_id: 2 })));
    }
    testCase.custom_steps_separated = steps;
  } else {
    testCase.custom_mission = "Explore the feature and look for usability problems.";
    testCase.custom_preconds = "Use a fresh browser profile.";
  }
  if (i % 7 === 0) {
    attachment(6000 + i, id, `spec-${id}.png`);
  }
  cases.push(testCase);
}
