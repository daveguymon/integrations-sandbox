import { createSandboxServer, type BatchSyncResponse, type ContactsPageResponse } from "./server.js";
import { getScenarioOrThrow } from "./scenarios.js";

export interface SimulationEvent {
  type: "server" | "request" | "response" | "retry" | "pagination" | "summary";
  message: string;
}

export interface SimulationReport {
  scenarioId: string;
  scenarioTitle: string;
  success: boolean;
  partial: boolean;
  requestCount: number;
  retryCount: number;
  transientErrorCount: number;
  rateLimitCount: number;
  pagesFetched: number;
  contactsFetched: number;
  acceptedIds: string[];
  failedIds: string[];
  events: SimulationEvent[];
}

export interface SimulationOptions {
  scenarioId: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export async function simulateScenario(options: SimulationOptions): Promise<SimulationReport> {
  const scenario = getScenarioOrThrow(options.scenarioId);
  const maxRetries = options.maxRetries ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const events: SimulationEvent[] = [];
  const server = await createSandboxServer({ scenarioId: scenario.id });
  const acceptedIds: string[] = [];
  const failedIds: string[] = [];
  let requestCount = 0;
  let retryCount = 0;
  let transientErrorCount = 0;
  let rateLimitCount = 0;
  let pagesFetched = 0;
  const fetchedIds: string[] = [];

  events.push({
    type: "server",
    message: `Started ${scenario.serviceName} sandbox for "${scenario.id}" at ${server.baseUrl}`
  });

  try {
    let nextPage: number | null = 1;

    while (nextPage !== null) {
      let attempt = 0;
      let pageLoaded = false;

      while (!pageLoaded) {
        attempt += 1;
        requestCount += 1;
        const pagePath: string = `/contacts?page=${nextPage}&pageSize=${scenario.defaultPageSize}`;
        events.push({
          type: "request",
          message: `GET ${pagePath} (attempt ${attempt})`
        });
        const response: Response = await fetch(`${server.baseUrl}${pagePath}`);
        const responseBody: unknown = await response.json();

        if (response.status === 500) {
          transientErrorCount += 1;
          events.push({
            type: "response",
            message: `Received 500 from ${pagePath}`
          });
          await retryOrThrow({
            attempt,
            maxRetries,
            retryCountUpdater: () => {
              retryCount += 1;
            },
            delayMs: retryDelayMs,
            events,
            reason: "retrying after transient upstream failure"
          });
          continue;
        }

        if (response.status === 429) {
          rateLimitCount += 1;
          const delayMs = getRetryDelayFromHeaders(response, retryDelayMs);
          events.push({
            type: "response",
            message: `Received 429 from ${pagePath}`
          });
          await retryOrThrow({
            attempt,
            maxRetries,
            retryCountUpdater: () => {
              retryCount += 1;
            },
            delayMs,
            events,
            reason: `waiting ${delayMs}ms for rate limit recovery`
          });
          continue;
        }

        if (!response.ok) {
          throw new Error(`Unexpected ${response.status} response while reading contacts.`);
        }

        assertContactsPageResponse(responseBody);
        pagesFetched += 1;
        fetchedIds.push(...responseBody.items.map((item) => item.id));
        nextPage = responseBody.nextPage;
        events.push({
          type: "response",
          message: `Loaded page ${responseBody.page} with ${responseBody.items.length} contacts`
        });

        if (nextPage !== null) {
          events.push({
            type: "pagination",
            message: `Following nextPage=${nextPage}`
          });
        }

        pageLoaded = true;
      }
    }

    requestCount += 1;
    events.push({
      type: "request",
      message: `POST /contacts/batch-sync for ${fetchedIds.length} contacts`
    });
    const batchResponse = await fetch(`${server.baseUrl}/contacts/batch-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ids: fetchedIds })
    });

    if (!batchResponse.ok) {
      throw new Error(`Unexpected ${batchResponse.status} response while syncing contacts.`);
    }

    const batchBody = await batchResponse.json();
    assertBatchSyncResponse(batchBody);
    acceptedIds.push(...batchBody.acceptedIds);
    failedIds.push(...batchBody.failed.map((entry) => entry.id));
    events.push({
      type: "response",
      message: batchBody.partial
        ? `Batch sync finished with ${batchBody.failed.length} item failures`
        : "Batch sync finished successfully"
    });

    const partial = batchBody.partial;
    events.push({
      type: "summary",
      message: partial ? "Simulation completed with partial failures." : "Simulation completed successfully."
    });

    return {
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      success: !partial,
      partial,
      requestCount,
      retryCount,
      transientErrorCount,
      rateLimitCount,
      pagesFetched,
      contactsFetched: fetchedIds.length,
      acceptedIds,
      failedIds,
      events
    };
  } finally {
    await server.stop();
  }
}

async function retryOrThrow(args: {
  attempt: number;
  maxRetries: number;
  retryCountUpdater: () => void;
  delayMs: number;
  events: SimulationEvent[];
  reason: string;
}): Promise<void> {
  const { attempt, maxRetries, retryCountUpdater, delayMs, events, reason } = args;

  if (attempt > maxRetries) {
    throw new Error(`Exceeded max retries (${maxRetries}).`);
  }

  retryCountUpdater();
  events.push({
    type: "retry",
    message: `Retry ${attempt}/${maxRetries}: ${reason}`
  });

  await sleep(delayMs);
}

function getRetryDelayFromHeaders(response: Response, fallbackMs: number): number {
  const customDelayMs = response.headers.get("x-retry-after-ms");

  if (customDelayMs !== null) {
    const parsedDelay = Number.parseInt(customDelayMs, 10);

    if (Number.isInteger(parsedDelay) && parsedDelay >= 0) {
      return parsedDelay;
    }
  }

  const retryAfter = response.headers.get("retry-after");

  if (retryAfter !== null) {
    const parsedSeconds = Number.parseInt(retryAfter, 10);

    if (Number.isInteger(parsedSeconds) && parsedSeconds >= 0) {
      return parsedSeconds * 1000;
    }
  }

  return fallbackMs;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function assertContactsPageResponse(value: unknown): asserts value is ContactsPageResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected contacts response to be an object.");
  }

  if (!("items" in value) || !Array.isArray(value.items) || !("page" in value)) {
    throw new Error("Contacts response is missing required pagination fields.");
  }
}

function assertBatchSyncResponse(value: unknown): asserts value is BatchSyncResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected batch sync response to be an object.");
  }

  if (!("acceptedIds" in value) || !Array.isArray(value.acceptedIds) || !("failed" in value)) {
    throw new Error("Batch sync response is missing required result fields.");
  }
}
