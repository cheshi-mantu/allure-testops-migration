import { createTestOpsMock } from "./testops.js";
import { createTestRailMock } from "./testrail.js";
import { createAlmMock } from "./alm.js";
import { createQaseMock } from "./qase.js";
import { createXrayMock } from "./xray.js";
import { createZephyrMock } from "./zephyr.js";
import { createSquadMock } from "./squad.js";

/**
 * Starts both fake servers for local development:
 * TestRail   on TESTRAIL_PORT (default 4001), user demo@example.com, API key demo-api-key
 * TestOps    on TESTOPS_PORT  (default 4002), API token demo-api-token
 * Jira+Xray  on XRAY_PORT     (default 4003), Jira demo@example.com / demo-jira-token, Xray demo-client-id / demo-client-secret
 * Qase       on QASE_PORT     (default 4004), API token demo-qase-token
 * ALM        on ALM_PORT      (default 4005), user demo / demo-password, API key demo-client / demo-secret
 * Zephyr+Jira on ZEPHYR_PORT  (default 4006), Zephyr API at /v2 with token demo-zephyr-token, Jira demo@example.com / demo-jira-token
 * Squad+Jira  on SQUAD_PORT   (default 4007), Zephyr Squad API at /connect with keys demo-access-key / demo-secret-key, Jira demo@example.com / demo-jira-token
 * TESTOPS_LATENCY_MS delays every Allure TestOps answer, to try the tool against a slow instance.
 */
const host = process.env.HOST ?? "0.0.0.0";
const testrailPort = Number(process.env.TESTRAIL_PORT ?? 4001);
const testopsPort = Number(process.env.TESTOPS_PORT ?? 4002);
const xrayPort = Number(process.env.XRAY_PORT ?? 4003);
const qasePort = Number(process.env.QASE_PORT ?? 4004);
const almPort = Number(process.env.ALM_PORT ?? 4005);
const zephyrPort = Number(process.env.ZEPHYR_PORT ?? 4006);
const squadPort = Number(process.env.SQUAD_PORT ?? 4007);

const testrail = createTestRailMock({ legacyPagination: process.env.TESTRAIL_LEGACY === "true" });
const testops = createTestOpsMock({ latencyMs: Number(process.env.TESTOPS_LATENCY_MS ?? 0) });
await testrail.listen({ host, port: testrailPort });
await testops.app.listen({ host, port: testopsPort });
const xray = createXrayMock();
await xray.app.listen({ host, port: xrayPort });
const qase = createQaseMock();
await qase.app.listen({ host, port: qasePort });
const alm = createAlmMock();
await alm.app.listen({ host, port: almPort });
const zephyr = createZephyrMock();
await zephyr.app.listen({ host, port: zephyrPort });
const squad = createSquadMock();
await squad.app.listen({ host, port: squadPort });
console.log(`Fake TestRail on :${testrailPort} (demo@example.com / demo-api-key)`);
console.log(`Fake Allure TestOps on :${testopsPort} (token demo-api-token)`);
console.log(`Fake Qase on :${qasePort} (token demo-qase-token)`);
console.log(`Fake ALM on :${almPort} (demo / demo-password, API key demo-client / demo-secret)`);
console.log(`Fake Zephyr and Jira on :${zephyrPort} (Zephyr API http://localhost:${zephyrPort}/v2, token demo-zephyr-token; Jira demo@example.com / demo-jira-token)`);
console.log(`Fake Zephyr Squad and Jira on :${squadPort} (Zephyr Squad API http://localhost:${squadPort}/connect, keys demo-access-key / demo-secret-key; Jira demo@example.com / demo-jira-token)`);
console.log(`Fake Jira and Xray Cloud on :${xrayPort} (Jira demo@example.com / demo-jira-token, Xray demo-client-id / demo-client-secret)`);
