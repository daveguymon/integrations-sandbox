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
  it("serves numbered paginated contacts", async () => {
    const server = await createSandboxServer({ scenarioId: "happy-path" });
    serversToStop.push(server);

    const response = await fetch(`${server.baseUrl}/contacts?page=2&pageSize=2`);
    const body = (await response.json()) as {
      items: Array<{ id: string }>;
      nextPage: number | null;
      page: number;
      paginationMode: string;
    };

    expect(response.status).toBe(200);
    expect(body.paginationMode).toBe("page");
    expect(body.page).toBe(2);
    expect(body.items.map((item) => item.id)).toEqual(["contact_3", "contact_4"]);
    expect(body.nextPage).toBe(3);
  });

  it("serves cursor paginated contacts", async () => {
    const server = await createSandboxServer({ scenarioId: "cursor-pagination" });
    serversToStop.push(server);

    const firstResponse = await fetch(`${server.baseUrl}/contacts?pageSize=2`);
    const firstBody = (await firstResponse.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
      paginationMode: string;
    };

    const secondResponse = await fetch(`${server.baseUrl}/contacts?pageSize=2&cursor=${firstBody.nextCursor}`);
    const secondBody = (await secondResponse.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };

    expect(firstResponse.status).toBe(200);
    expect(firstBody.paginationMode).toBe("cursor");
    expect(firstBody.items.map((item) => item.id)).toEqual(["contact_1", "contact_2"]);
    expect(firstBody.nextCursor).toBe("cursor_2");
    expect(secondBody.items.map((item) => item.id)).toEqual(["contact_3", "contact_4"]);
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

  it("completes cursor-based simulations", async () => {
    const report = await simulateScenario({
      scenarioId: "cursor-pagination",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(true);
    expect(report.paginationMode).toBe("cursor");
    expect(report.pagesFetched).toBe(3);
    expect(report.contactsFetched).toBe(6);
  });

  it("refreshes auth after token expiry", async () => {
    const report = await simulateScenario({
      scenarioId: "auth-expiry",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(true);
    expect(report.authRefreshCount).toBe(1);
    expect(report.events.some((event) => event.type === "auth" && event.message.includes("refreshing expired bearer token"))).toBe(true);
  });

  it("retries outbound webhook deliveries", async () => {
    const report = await simulateScenario({
      scenarioId: "webhook-retries",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(true);
    expect(report.webhookAttemptCount).toBe(3);
    expect(report.webhookRetryCount).toBe(2);
    expect(report.webhookFailureCount).toBe(2);
  });

  it("surfaces malformed payloads as simulation errors", async () => {
    const report = await simulateScenario({
      scenarioId: "malformed-payload",
      maxRetries: 4,
      retryDelayMs: 0
    });

    expect(report.success).toBe(false);
    expect(report.partial).toBe(false);
    expect(report.errorMessage).toBe("Contacts response is missing required pagination fields.");
  });
});
