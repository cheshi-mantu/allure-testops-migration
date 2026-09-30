import { createTestOpsMock } from "./testops.js";
import { createTestRailMock } from "./testrail.js";

/**
 * Starts both fake servers for local development:
 * TestRail   on TESTRAIL_PORT (default 4001), user demo@example.com, API key demo-api-key
 * TestOps    on TESTOPS_PORT  (default 4002), API token demo-api-token
 * TESTOPS_LATENCY_MS delays every Allure TestOps answer, to try the tool against a slow instance.
 */
const host = process.env.HOST ?? "0.0.0.0";
const testrailPort = Number(process.env.TESTRAIL_PORT ?? 4001);
const testopsPort = Number(process.env.TESTOPS_PORT ?? 4002);

const testrail = createTestRailMock({ legacyPagination: process.env.TESTRAIL_LEGACY === "true" });
const testops = createTestOpsMock({ latencyMs: Number(process.env.TESTOPS_LATENCY_MS ?? 0) });
await testrail.listen({ host, port: testrailPort });
await testops.app.listen({ host, port: testopsPort });
console.log(`Fake TestRail on :${testrailPort} (demo@example.com / demo-api-key)`);
console.log(`Fake Allure TestOps on :${testopsPort} (token demo-api-token)`);
