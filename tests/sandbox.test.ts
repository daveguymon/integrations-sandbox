import { afterEach, describe, expect, it } from "vitest";

import { createSandboxServer } from "../src/server.js";
import { simulateScenario } from "../src/simulator.js";

const serversToStop: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (serversToStop.length > 0) {
    const server = serversToStop.pop();

    if (server) {
      await server.stop();
    }
  }
});

describe("integration sandbox", () => {
  it("serves paginated contacts", async () => {
    const server = await createSandboxServer({ scenarioId: "happy-path" });
    serversToStop.push(server);

    const response = await fetch(`${server.baseUrl}/contacts?page=2&pageSize=2`);
    const body = (await response.json()) as {
      items: Array<{ id: string }>;
      nextPage: number | null;
      page: number;
    };

    expect(response.status).toBe(200);
    expect(body.page).toBe(2);
    expect(body.items.map((item) => item.id)).toEqual(["contact_3", "contact_4"]);
    expect(body.nextPage).toBe(3);
  });

  it("retries transient failures and completes the sync", async () => {
    const report = await simulateScenario({
      scenarioId: "flaky-retries",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(true);
    expect(report.retryCount).toBe(2);
    expect(report.transientErrorCount).toBe(2);
    expect(report.contactsFetched).toBe(6);
    expect(report.pagesFetched).toBe(3);
  });

  it("recovers from rate limits", async () => {
    const report = await simulateScenario({
      scenarioId: "rate-limit-recover",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(true);
    expect(report.rateLimitCount).toBe(1);
    expect(report.retryCount).toBe(1);
    expect(report.contactsFetched).toBe(6);
  });

  it("surfaces partial batch failures", async () => {
    const report = await simulateScenario({
      scenarioId: "partial-batch-failure",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(false);
    expect(report.partial).toBe(true);
    expect(report.failedIds).toEqual(["contact_2", "contact_5"]);
    expect(report.acceptedIds).toHaveLength(4);
  });
});
