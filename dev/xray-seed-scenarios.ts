/**
 * Test scenarios for dev/xray-seed.ts: realistic Manual, Cucumber and Generic tests of a web shop,
 * its API and mobile app, plus variations that turn them into as many distinct tests as needed.
 * Text uses Jira wiki markup, as Xray stores it. Generation is deterministic.
 */

export type PreconditionName = "user" | "admin" | "cart" | "sandbox" | "device" | "emptyDb";

export interface StepTemplate {
  action?: string;
  data?: string;
  result?: string;
  /** Attach a screenshot or a data file to the step. */
  file?: "png" | "csv";
}

export interface Scenario {
  title: string;
  folder: string;
  component: string;
  labels: string[];
  type: "Manual" | "Cucumber" | "Generic";
  steps?: StepTemplate[];
  gherkin?: string;
  unstructured?: string;
  /** Start with a call to a shared test. */
  calls?: "logIn" | "openApp";
  preconditions?: PreconditionName[];
}

export const COMPONENTS = ["Auth", "Search", "Checkout", "Profile", "Admin", "Reports", "API", "Mobile"];
export const VERSIONS = ["1.0", "1.1", "2.0"];
const PRIORITIES = ["Highest", "High", "Medium", "Medium", "Low", "Lowest"];

export const SCENARIOS: Scenario[] = [
  // ---------------------------------------------------------------- Auth
  {
    title: "Reset a forgotten password",
    folder: "/Web/Auth/Password",
    component: "Auth",
    labels: ["password", "email"],
    type: "Manual",
    preconditions: ["user"],
    steps: [
      { action: "Open the login page and click *Forgot password?*", result: "The reset form is shown" },
      { action: "Enter the email", data: "{{jane@example.com}}", result: "The message _Check your inbox_ is shown" },
      { action: "Open the reset email in the test mailbox", data: "[Mailpit|https://mail.example.com]", result: "The email has a link valid for *30 minutes*" },
      { action: "Follow the link and enter a new password twice", data: "New password: {{Secret#2026}}", result: "The password is changed\n* the user is logged in\n* other sessions are closed" },
      { action: "Log out and log in with the old password", result: "The old password is rejected" },
    ],
  },
  {
    title: "Two-factor authentication with a one-time code",
    folder: "/Web/Auth/2FA",
    component: "Auth",
    labels: ["2fa", "security"],
    type: "Manual",
    preconditions: ["user"],
    steps: [
      { action: "Log in with a user who has 2FA enabled", result: "The code prompt is shown" },
      { action: "Enter the code from the authenticator app", data: "Seed: {{JBSWY3DPEHPK3PXP}}", result: "The dashboard opens" },
      { action: "Log out and enter an expired code", data: "A code older than 30 seconds", result: "{color:red}The code has expired{color} is shown" },
      { action: "Enter a wrong code five times", result: "The account is locked for *15 minutes*" },
    ],
  },
  {
    title: "Single sign-on with the company identity provider",
    folder: "/Web/Auth/SSO",
    component: "Auth",
    labels: ["sso", "saml"],
    type: "Manual",
    steps: [
      { action: "Click *Sign in with Okta*", result: "The browser goes to the identity provider" },
      { action: "Sign in there", data: "||Field||Value||\n|Login|jane.sso|\n|Password|from the vault|", result: "The browser comes back logged in" },
      { action: "Check the user profile", result: "Name and email come from the identity provider" },
    ],
  },
  {
    title: "Session expires after inactivity",
    folder: "/Web/Auth/Session",
    component: "Auth",
    labels: ["session"],
    type: "Manual",
    calls: "logIn",
    steps: [
      { action: "Leave the browser idle", data: "Idle timeout: {{20 min}} (set to {{1 min}} on staging)", result: "A warning appears one minute before the end" },
      { action: "Wait until the session ends", result: "The login page opens with the message _Your session has expired_" },
      { action: "Log in again", result: "The page that was open before is restored" },
    ],
  },
  {
    title: "Log in",
    folder: "/Web/Auth/Login",
    component: "Auth",
    labels: ["bdd", "login"],
    type: "Cucumber",
    gherkin: 'Given I am on the login page\nWhen I log in as "jane@example.com" with password "secret"\nThen I see the dashboard\nAnd the header shows "Jane Doe"\nBut I do not see the admin menu',
  },
  {
    title: "Password rules",
    folder: "/Web/Auth/Password",
    component: "Auth",
    labels: ["bdd", "password", "validation"],
    type: "Cucumber",
    gherkin:
      'Given I am on the sign-up page\nWhen I enter the password "<password>"\nThen I see "<message>"\n\nExamples:\n  | password      | message                      |\n  | short         | At least 8 characters        |\n  | nouppercase1! | At least one capital letter  |\n  | NoDigits!!    | At least one digit           |\n  | Valid#Pass1   | Strong password              |',
  },

  {
    title: "Release smoke checklist",
    folder: "/Web",
    component: "Search",
    labels: ["checklist", "release"],
    type: "Manual",
    steps: [
      { action: "Open the home page" },
      { action: "Log in as a customer" },
      { action: "Search for a product" },
      { action: "Open a product page" },
      { action: "Add the product to the cart" },
      { action: "Apply a coupon" },
      { action: "Go through checkout with the test card" },
      { action: "Open My orders" },
      { action: "Change the profile name" },
      { action: "Upload an avatar" },
      { action: "Log out" },
      { action: "Log in as an admin" },
      { action: "Open the users list" },
      { action: "Open the sales report" },
      { action: "Export the report to PDF" },
      { action: "Open the audit log" },
      { action: "Check the version in the footer" },
      { action: "Check the health endpoint" },
      { action: "Check the error tracker for new errors" },
      { action: "Post the result to the release channel" },
    ],
  },
  {
    title: "Exploratory session: new checkout design",
    folder: "/Web/Shop/Checkout",
    component: "Checkout",
    labels: ["exploratory"],
    type: "Manual",
    steps: [
      { action: "Spend 30 minutes on the new checkout", data: "Charter: find what confuses a first-time buyer" },
      { action: "Write down every question you had" },
      { action: "File bugs for real problems and link them here" },
    ],
  },

  // ---------------------------------------------------------------- Search
  {
    title: "Search with filters and sorting",
    folder: "/Web/Shop/Search",
    component: "Search",
    labels: ["search", "filters"],
    type: "Manual",
    steps: [
      { action: "Search for {{phone}}", result: "At least 20 results are shown" },
      { action: "Filter by brand and price", data: "||Filter||Value||\n|Brand|Acme, Globex|\n|Price|100 to 500|", result: "Only matching products are listed\n* the counter shows the number of results\n* the filters are in the URL" },
      { action: "Sort by price, highest first", result: "Prices go down the list" },
      { action: "Reload the page", result: "Filters and sorting are kept" },
      { action: "Click *Clear all*", result: "All results are shown again" },
    ],
  },
  {
    title: "Search suggestions",
    folder: "/Web/Shop/Search",
    component: "Search",
    labels: ["bdd", "search"],
    type: "Cucumber",
    gherkin: 'Given the catalog has the products:\n  | name          | category |\n  | Phone X       | Phones   |\n  | Phone X case  | Cases    |\n  | Photo printer | Printers |\nWhen I type "pho" in the search box\nThen I see 3 suggestions\nAnd "Phone X" is the first one',
  },
  {
    title: "Search for something that does not exist",
    folder: "/Web/Shop/Search",
    component: "Search",
    labels: ["search", "negative"],
    type: "Manual",
    steps: [
      { action: "Search for a random string", data: "{{qwertyuiop12345}}", result: "_Nothing found_ with suggestions to check the spelling" },
      { action: "Search for 300 characters", data: "{{aaaa...}} x300", result: "The query is cut to 200 characters, no error" },
      { action: "Search for HTML", data: "{{<script>alert(1)</script>}}", result: "The text is shown as typed, no script runs" },
    ],
  },

  // ---------------------------------------------------------------- Cart and checkout
  {
    title: "Apply a coupon in the cart",
    folder: "/Web/Shop/Cart",
    component: "Checkout",
    labels: ["cart", "coupon"],
    type: "Manual",
    preconditions: ["cart"],
    steps: [
      { action: "Open the cart", result: "Two items, total *$150.00*" },
      { action: "Enter a coupon", data: "{{SAVE10}}", result: "10% off, total *$135.00*" },
      { action: "Enter a second coupon", data: "{{FREESHIP}}", result: "_Only one coupon per order_" },
      { action: "Remove the coupon", result: "The total is $150.00 again" },
      { action: "Enter an expired coupon", data: "{{SUMMER2020}}", result: "_This coupon has expired_" },
    ],
  },
  {
    title: "Pay with a card that needs 3-D Secure",
    folder: "/Web/Shop/Checkout",
    component: "Checkout",
    labels: ["payment", "3ds"],
    type: "Manual",
    calls: "logIn",
    preconditions: ["cart", "sandbox"],
    steps: [
      { action: "Go to checkout and choose card payment", result: "The card form is shown" },
      { action: "Enter the test card", data: "{code:json}\n{\"number\": \"4000 0027 6000 3184\", \"expiry\": \"12/30\", \"cvc\": \"123\"}\n{code}", result: "The bank page opens in a frame" },
      { action: "Confirm the payment on the bank page", result: "The order confirmation is shown" },
      { action: "Repeat and click *Fail* on the bank page", result: "_Payment was declined_, the cart is kept" },
    ],
  },
  {
    title: "Full purchase journey from search to delivery",
    folder: "/Web/Shop/Checkout",
    component: "Checkout",
    labels: ["e2e", "journey", "regression"],
    type: "Manual",
    calls: "logIn",
    preconditions: ["user", "sandbox"],
    steps: [
      { action: "Search for {{headphones}}", result: "Results are shown" },
      { action: "Open the first product", result: "Photos, price and stock are shown" },
      { action: "Choose a colour", data: "Black", result: "The photo changes" },
      { action: "Add to cart", result: "The cart counter shows 1" },
      { action: "Search for {{cable}} and add one", result: "The cart counter shows 2" },
      { action: "Open the cart", result: "Both products with prices" },
      { action: "Change the quantity of the cable to 3", result: "The total is updated" },
      { action: "Go to checkout", result: "The address step opens" },
      { action: "Choose the saved address", result: "Delivery options are shown" },
      { action: "Choose express delivery", data: "Express, next day", result: "The delivery price is added" },
      { action: "Choose card payment", result: "The card form is shown" },
      { action: "Pay with the test card", data: "{{4242 4242 4242 4242}}", result: "The order confirmation is shown", file: "png" },
      { action: "Open *My orders*", result: "The order is in status _Paid_" },
      { action: "Check the confirmation email", result: "The email lists both products and the total" },
      { action: "In the admin panel, ship the order", result: "The status becomes _Shipped_" },
      { action: "Open the tracking link", result: "The courier page opens" },
      { action: "Mark the order as delivered in the courier sandbox", result: "The status becomes _Delivered_" },
      { action: "Leave a review for the headphones", data: "5 stars, \"Great sound\"", result: "The review waits for moderation" },
      { result: "No errors in the browser console during the whole journey" },
    ],
  },
  {
    title: "Refund a returned order",
    folder: "/Web/Shop/Refunds",
    component: "Checkout",
    labels: ["refund", "admin"],
    type: "Manual",
    preconditions: ["admin", "sandbox"],
    steps: [
      { action: "Find a delivered order in the admin panel", data: "Order {{#100234}}", result: "The order page opens" },
      { action: "Click *Refund* and choose the items", data: "||Item||Qty||Reason||\n|Headphones|1|Damaged|", result: "The refund amount is calculated" },
      { action: "Confirm", result: "The payment provider shows the refund" },
      { action: "Open the order as the customer", result: "Status _Refunded_, with the amount" },
    ],
  },
  {
    title: "Checkout totals",
    folder: "/Web/Shop/Checkout",
    component: "Checkout",
    labels: ["bdd", "checkout", "tax"],
    type: "Cucumber",
    gherkin:
      'Given my cart has:\n  | product | price | qty |\n  | Book    | 10.00 | 2   |\n  | Pen     | 1.50  | 4   |\nAnd I ship to "<country>"\nWhen I open the checkout\nThen the tax is <tax>\nAnd the total is <total>\n\nExamples:\n  | country | tax  | total |\n  | Germany | 4.94 | 30.94 |\n  | France  | 5.20 | 31.20 |\n  | USA     | 0.00 | 26.00 |',
  },

  // ---------------------------------------------------------------- Profile
  {
    title: "Change the avatar",
    folder: "/Web/Profile",
    component: "Profile",
    labels: ["profile", "upload"],
    type: "Manual",
    calls: "logIn",
    steps: [
      { action: "Open the profile and click the avatar", result: "The upload dialog opens" },
      { action: "Upload a picture", data: "avatar.png, 2 MB", result: "A crop frame is shown", file: "png" },
      { action: "Crop and save", result: "The new avatar is shown in the header" },
      { action: "Upload a 20 MB picture", result: "_The file is larger than 10 MB_" },
      { action: "Upload a PDF", result: "_Only JPG, PNG and WebP are allowed_" },
    ],
  },
  {
    title: "Manage the address book",
    folder: "/Web/Profile/Addresses",
    component: "Profile",
    labels: ["profile", "address"],
    type: "Manual",
    calls: "logIn",
    steps: [
      { action: "Add an address", data: "||Field||Value||\n|Street|Hauptstr. 1|\n|City|Berlin|\n|Zip|10115|\n|Country|Germany|", result: "The address is in the list" },
      { action: "Add a second address and make it the default", result: "It moves to the top with a _Default_ badge" },
      { action: "Edit the zip code", data: "{{1011}}", result: "_The zip code must have 5 digits_" },
      { action: "Delete the default address", result: "The other address becomes the default" },
    ],
  },
  {
    title: "Notification settings",
    folder: "/Web/Profile",
    component: "Profile",
    labels: ["notifications"],
    type: "Manual",
    steps: [{ action: "Turn off marketing emails and save", result: "No marketing email arrives for a week; order emails still arrive" }],
  },

  // ---------------------------------------------------------------- Admin
  {
    title: "Give a user the manager role",
    folder: "/Web/Admin/Users",
    component: "Admin",
    labels: ["admin", "roles", "security"],
    type: "Manual",
    preconditions: ["admin", "user"],
    steps: [
      { action: "Open *Users* and find jane", result: "The user page opens" },
      { action: "Add the role", data: "Manager", result: "The role is listed" },
      { action: "Log in as jane in another browser", result: "The *Reports* menu is visible" },
      { action: "Open the audit log", result: "An entry: _admin added role Manager to jane_" },
      { action: "Remove the role", result: "jane loses access on the next page load" },
    ],
  },
  {
    title: "Audit log export",
    folder: "/Web/Admin/Audit",
    component: "Admin",
    labels: ["admin", "audit", "export"],
    type: "Manual",
    preconditions: ["admin"],
    steps: [
      { action: "Open the audit log and filter the last 7 days", result: "Entries of the last week only" },
      { action: "Export to CSV", result: "A file with columns {{time, user, action, object}}", file: "csv" },
      { action: "Open the file in a spreadsheet", result: "Dates are in ISO 8601, no broken characters" },
    ],
  },

  // ---------------------------------------------------------------- Reports
  {
    title: "Sales report for a date range",
    folder: "/Web/Reports",
    component: "Reports",
    labels: ["reports", "export"],
    type: "Manual",
    steps: [
      { action: "Open *Reports → Sales*", result: "The report for this month is shown" },
      { action: "Choose a range", data: "From 2026-01-01 to 2026-03-31", result: "Three months, grouped by week" },
      { action: "Export to PDF", result: "The PDF has the same numbers and the chart" },
      { action: "Choose a range longer than a year", result: "_The range cannot exceed 12 months_" },
    ],
  },

  // ---------------------------------------------------------------- API
  {
    title: "Create, read, update and delete a product through the API",
    folder: "/API/v2/Products",
    component: "API",
    labels: ["api", "crud"],
    type: "Manual",
    steps: [
      { action: "POST {{/api/v2/products}}", data: "{code:json}\n{\"name\": \"Mug\", \"price\": 9.9}\n{code}", result: "*201*, the body has an id" },
      { action: "GET {{/api/v2/products/{id}}}", result: "*200*, the same name and price" },
      { action: "PATCH the price", data: "{code:json}\n{\"price\": 12.5}\n{code}", result: "*200*, the price is 12.5" },
      { action: "DELETE the product", result: "*204*" },
      { action: "GET it again", result: "*404* with {{{\"error\": \"not_found\"}}}" },
    ],
  },
  {
    title: "API pagination and rate limits",
    folder: "/API/v2",
    component: "API",
    labels: ["api", "paging", "performance"],
    type: "Manual",
    steps: [
      { action: "GET {{/api/v2/products?page=0&size=50}}", result: "50 items and a {{next}} link" },
      { action: "Follow the {{next}} links to the end", result: "Every product exactly once" },
      { action: "Send 101 requests in one minute", result: "The 101st gets *429* with {{Retry-After}}" },
    ],
  },
  { title: "Products API contract", folder: "/API/v2/Products", component: "API", labels: ["api", "automated", "contract"], type: "Generic", unstructured: "com.example.api.ProductsContractTest" },
  { title: "Orders API smoke", folder: "/API/v2", component: "API", labels: ["api", "automated", "smoke"], type: "Generic", unstructured: "tests/api/test_orders.py::test_create_and_pay" },
  { title: "Checkout load test", folder: "/API/Performance", component: "API", labels: ["performance", "automated"], type: "Generic", unstructured: "k6 run perf/checkout.js --vus 200 --duration 10m" },
  { title: "Postman collection: public API", folder: "/API", component: "API", labels: ["api", "automated", "postman"], type: "Generic", unstructured: "newman run collections/public-api.json -e staging.json" },
  { title: "Visual regression of the home page", folder: "/Web", component: "Search", labels: ["automated", "visual"], type: "Generic", unstructured: "npx playwright test tests/visual/home.spec.ts" },
  {
    title: "Orders API",
    folder: "/API/v2",
    component: "API",
    labels: ["bdd", "api"],
    type: "Cucumber",
    gherkin:
      'Given I have an API token\nWhen I send POST "/api/v2/orders" with:\n  """\n  {"items": [{"sku": "MUG-1", "qty": 2}]}\n  """\nThen the response status is 201\nAnd the response has "status" equal to "created"',
  },

  // ---------------------------------------------------------------- Mobile
  {
    title: "Browse the catalog offline",
    folder: "/Mobile/Catalog",
    component: "Mobile",
    labels: ["mobile", "offline"],
    type: "Manual",
    calls: "openApp",
    preconditions: ["device"],
    steps: [
      { action: "Open the catalog with network on", result: "Products load" },
      { action: "Turn on airplane mode", result: "A banner _You are offline_" },
      { action: "Open products seen before", result: "They open from the cache" },
      { action: "Try to add to cart", result: "_Will be added when you are back online_" },
      { action: "Turn the network back on", result: "The product is in the cart" },
    ],
  },
  {
    title: "Push notification opens the order",
    folder: "/Mobile/Notifications",
    component: "Mobile",
    labels: ["mobile", "push"],
    type: "Manual",
    calls: "openApp",
    preconditions: ["device", "user"],
    steps: [
      { action: "Allow notifications", result: "" },
      { action: "Ship an order from the admin panel", data: "Order {{#100235}}", result: "A push _Your order is on its way_ arrives" },
      { action: "Tap the notification", result: "The order page opens in the app" },
    ],
  },
  {
    title: "Deep link to a product",
    folder: "/Mobile",
    component: "Mobile",
    labels: ["mobile", "deeplink"],
    type: "Cucumber",
    gherkin: 'Given the app is installed\nWhen I open the link "shop://product/MUG-1"\nThen the product page of "Mug" opens\n\nScenario: app not installed\nGiven the app is not installed\nWhen I open the link "https://shop.example.com/p/MUG-1"\nThen the store page of the app opens',
  },
  {
    title: "Rotate the screen during checkout",
    folder: "/Mobile/Checkout",
    component: "Mobile",
    labels: ["mobile", "orientation"],
    type: "Manual",
    calls: "openApp",
    preconditions: ["device", "cart"],
    steps: [
      { action: "Start checkout in portrait", result: "" },
      { action: "Rotate to landscape on the address step", result: "Entered data is kept, the layout adapts" },
      { action: "Rotate back and finish the order", result: "The order is placed" },
    ],
  },
];

/** Ways to turn one scenario into another test. */
interface Variation {
  suffix: string;
  folder?: string;
  label: string;
  /** Extra step in front, for the environment of the variation. */
  setup?: StepTemplate;
  /** Extra check at the end. */
  check?: StepTemplate;
}

const VARIATIONS: Variation[] = [
  { suffix: "in Chrome", label: "chrome", setup: { action: "Open the shop in Chrome", data: "Chrome latest, 1920x1080" } },
  { suffix: "in Firefox", label: "firefox", setup: { action: "Open the shop in Firefox", data: "Firefox ESR" } },
  { suffix: "in Safari", label: "safari", setup: { action: "Open the shop in Safari", data: "Safari 18, macOS" } },
  { suffix: "on a phone", label: "mobile-web", setup: { action: "Open the shop in a phone browser", data: "iPhone 15, Safari" }, check: { result: "Nothing overflows the screen; buttons are at least 44 px" } },
  { suffix: "on a slow network", label: "slow-network", setup: { action: "Throttle the network", data: "Fast 3G in the developer tools" }, check: { result: "Spinners are shown, no double submits" } },
  { suffix: "in German", label: "i18n", setup: { action: "Switch the language", data: "Deutsch (de-DE)" }, check: { result: "All texts are translated, dates are DD.MM.YYYY, prices are 1.234,56 €" } },
  { suffix: "in Japanese", label: "i18n", setup: { action: "Switch the language", data: "日本語 (ja-JP)" }, check: { result: "Long words wrap correctly" } },
  { suffix: "as an admin", label: "admin", setup: { action: "Log in as an admin", data: "{{admin@example.com}}" }, check: { result: "Admin actions are available on the page" } },
  { suffix: "with the screen reader", label: "a11y", setup: { action: "Turn on VoiceOver" }, check: { result: "Every control is announced with its name and state" } },
  { suffix: "with an empty input", label: "negative", check: { action: "Leave the required fields empty and submit", result: "Every empty field is marked; nothing is sent" } },
  { suffix: "with 256 characters", label: "boundary", check: { action: "Enter 256 characters in every text field", result: "Inputs stop at 255 characters" } },
  { suffix: "with emoji 😀", label: "unicode", check: { action: "Enter text with emoji and RTL characters", data: "😀 שלום مرحبا", result: "Text is saved and shown unchanged" } },
  { suffix: "after a deploy", label: "smoke", setup: { action: "Check the version in the footer", data: "Build from the release pipeline" } },
];

/**
 * How the steps of a Manual test look: as written, steps only, without expected results, one check
 * at the end, or long (with or without expected results). Real projects mix all of them.
 */
type Shape = "asWritten" | "stepsOnly" | "noExpected" | "checkAtEnd" | "longStepsOnly" | "longWithExpected";

const SHAPES: { shape: Shape; weight: number; label: string }[] = [
  { shape: "asWritten", weight: 35, label: "shape-as-written" },
  { shape: "stepsOnly", weight: 20, label: "shape-steps-only" },
  { shape: "noExpected", weight: 15, label: "shape-no-expected" },
  { shape: "checkAtEnd", weight: 10, label: "shape-check-at-end" },
  { shape: "longStepsOnly", weight: 10, label: "shape-long-steps-only" },
  { shape: "longWithExpected", weight: 10, label: "shape-long" },
];

/** Steps that fit into any test, to make long ones. */
const FILLER: StepTemplate[] = [
  { action: "Wait until the page has loaded", result: "No spinner is shown" },
  { action: "Take a screenshot of the page", result: "The screenshot is attached to the run" },
  { action: "Check the browser console", result: "No errors or warnings" },
  { action: "Reload the page", result: "The state is the same as before" },
  { action: "Press Tab through the page", result: "The focus is always visible" },
  { action: "Open the same page in a second tab", result: "Both tabs show the same data" },
  { action: "Check the network panel", data: "Filter: XHR", result: "No request failed" },
  { action: "Zoom the page to 200%", result: "Nothing overlaps" },
  { action: "Switch to the dark theme", result: "Text stays readable" },
  { action: "Go back with the browser button", result: "The previous page is shown" },
  { action: "Copy the page URL and open it in a private window", result: "The login page or the same page opens" },
  { action: "Check the page title", result: "The title names the page" },
];

/** Reshapes the steps of a Manual test; the content stays, only what the steps carry changes. */
function reshape(steps: StepTemplate[], shape: Shape, rnd: ReturnType<typeof random>): StepTemplate[] {
  const lengthen = (list: StepTemplate[]) => {
    const target = 15 + Math.floor(rnd.next() * 11);
    const result = [...list];
    while (result.length < target) {
      result.splice(1 + Math.floor(rnd.next() * result.length), 0, rnd.pick(FILLER));
    }
    return result;
  };
  const withAction = (list: StepTemplate[]) => list.filter((s) => s.action);
  switch (shape) {
    case "stepsOnly":
      return withAction(steps).map((s) => ({ action: s.action, file: s.file }));
    case "noExpected":
      return withAction(steps).map((s) => ({ action: s.action, data: s.data, file: s.file }));
    case "checkAtEnd": {
      const actions = withAction(steps);
      return actions.map((s, index) => (index === actions.length - 1 ? s : { action: s.action, data: s.data }));
    }
    case "longStepsOnly":
      return lengthen(withAction(steps)).map((s) => ({ action: s.action }));
    case "longWithExpected":
      return lengthen(steps);
    default:
      return steps;
  }
}

function pickShape(rnd: ReturnType<typeof random>) {
  let roll = rnd.next() * SHAPES.reduce((sum, s) => sum + s.weight, 0);
  for (const entry of SHAPES) {
    roll -= entry.weight;
    if (roll < 0) {
      return entry;
    }
  }
  return SHAPES[0]!;
}

/** Small deterministic random generator, so reruns create the same tests. */
export function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (probability: number) => next() < probability,
  };
}

export interface GeneratedTest extends Scenario {
  priority: string;
  fixVersion: string | null;
  assignToMe: boolean;
}

/** The scenarios once each, then variations of them: `count` distinct tests in total. */
export function generate(count: number, seed = 1): GeneratedTest[] {
  const rnd = random(seed);
  const result: GeneratedTest[] = [];
  for (let i = 0; i < count; i++) {
    const base = SCENARIOS[i % SCENARIOS.length]!;
    const round = Math.floor(i / SCENARIOS.length);
    const variation = round === 0 ? null : VARIATIONS[(round - 1 + i) % VARIATIONS.length]!;
    const repeat = round > VARIATIONS.length ? ` #${round}` : "";
    const scenario: Scenario = variation
      ? {
          ...base,
          title: `${base.title} ${variation.suffix}${repeat}`,
          labels: [...base.labels, variation.label],
          // Cucumber and Generic tests keep their definition; Manual tests get the variation's steps.
          steps: base.steps ? [...(variation.setup ? [variation.setup] : []), ...base.steps, ...(variation.check ? [variation.check] : [])] : undefined,
        }
      : base;
    // Tests that are steps only by nature (checklists, sessions) stay as they are.
    const natural = base.steps?.every((step) => !step.result);
    const shape = scenario.steps && !natural ? pickShape(rnd) : null;
    result.push({
      ...scenario,
      steps: scenario.steps && shape ? reshape(scenario.steps, shape.shape, rnd) : scenario.steps,
      labels: shape ? [...scenario.labels, shape.label] : scenario.labels,
      priority: rnd.pick(PRIORITIES),
      fixVersion: rnd.chance(0.6) ? rnd.pick(VERSIONS) : null,
      assignToMe: rnd.chance(0.3),
    });
  }
  return result;
}

/** Folder paths and all their parents, parents first. */
export function folderPaths(tests: Scenario[]): string[] {
  const paths = new Set<string>();
  for (const test of tests) {
    const parts = test.folder.split("/").filter(Boolean);
    parts.forEach((_, index) => paths.add(`/${parts.slice(0, index + 1).join("/")}`));
  }
  return [...paths].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}
