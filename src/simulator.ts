import {
  createSandboxServer,
  type BatchSyncResponse,
  type ContactsResponse,
  type TokenResponse,
  type WebhookDeliveryResponse
} from "./server.js";
import { getScenarioOrThrow, type PaginationMode } from "./scenarios.js";

export interface SimulationEvent {
  type: "server" | "request" | "response" | "retry" | "pagination" | "auth" | "webhook" | "error" | "summary";
  message: string;
}

export interface SimulationReport {
  scenarioId: string;
  scenarioTitle: string;
  paginationMode: PaginationMode;
  success: boolean;
  partial: boolean;
  errorMessage: string | null;
  requestCount: number;
  retryCount: number;
  transientErrorCount: number;
  rateLimitCount: number;
  authRefreshCount: number;
  webhookAttemptCount: number;
  webhookRetryCount: number;
  webhookFailureCount: number;
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
  let authRefreshCount = 0;
  let webhookAttemptCount = 0;
  let webhookRetryCount = 0;
  let webhookFailureCount = 0;
  let pagesFetched = 0;
  const fetchedIds: string[] = [];
  let accessToken: string | null = null;

  events.push({
    type: "server",
    message: `Started ${scenario.serviceName} sandbox for "${scenario.id}" at ${server.baseUrl}`
  });

  try {
    if (scenario.behavior.requiresAuth) {
      accessToken = await requestAccessToken({
        baseUrl: server.baseUrl,
        events,
        requestCountUpdater: () => {
          requestCount += 1;
        },
        reason: "initial authentication"
      });
    }

    if (scenario.behavior.paginationMode === "cursor") {
      await fetchCursorPages();
    } else {
      await fetchNumberedPages();
    }

    const batchBody = await syncContacts();
    acceptedIds.push(...batchBody.acceptedIds);
    failedIds.push(...batchBody.failed.map((entry) => entry.id));

    if (scenario.behavior.enableWebhookDelivery) {
      await deliverWebhook();
    }

    const partial = batchBody.partial;
    events.push({
      type: "summary",
      message: partial ? "Simulation completed with partial failures." : "Simulation completed successfully."
    });

    return buildReport({
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      paginationMode: scenario.behavior.paginationMode,
      success: !partial,
      partial,
      errorMessage: null,
      requestCount,
      retryCount,
      transientErrorCount,
      rateLimitCount,
      authRefreshCount,
      webhookAttemptCount,
      webhookRetryCount,
      webhookFailureCount,
      pagesFetched,
      contactsFetched: fetchedIds.length,
      acceptedIds,
      failedIds,
      events
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unexpected simulation error.";
    events.push({
      type: "error",
      message
    });
    events.push({
      type: "summary",
      message: "Simulation failed."
    });

    return buildReport({
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      paginationMode: scenario.behavior.paginationMode,
      success: false,
      partial: false,
      errorMessage: message,
      requestCount,
      retryCount,
      transientErrorCount,
      rateLimitCount,
      authRefreshCount,
      webhookAttemptCount,
      webhookRetryCount,
      webhookFailureCount,
      pagesFetched,
      contactsFetched: fetchedIds.length,
      acceptedIds,
      failedIds,
      events
    });
  } finally {
    await server.stop();
  }

  async function fetchNumberedPages(): Promise<void> {
    let nextPage: number | null = 1;

    while (nextPage !== null) {
      const body = await loadContactsPage(`/contacts?page=${nextPage}&pageSize=${scenario.defaultPageSize}`);
      assertOffsetContactsResponse(body);
      pagesFetched += 1;
      fetchedIds.push(...body.items.map((item) => item.id));
      nextPage = body.nextPage;
      events.push({
        type: "response",
        message: `Loaded page ${body.page} with ${body.items.length} contacts`
      });

      if (nextPage !== null) {
        events.push({
          type: "pagination",
          message: `Following nextPage=${nextPage}`
        });
      }
    }
  }

  async function fetchCursorPages(): Promise<void> {
    let nextCursor: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const query = nextCursor === null ? "" : `&cursor=${nextCursor}`;
      const body = await loadContactsPage(`/contacts?pageSize=${scenario.defaultPageSize}${query}`);
      assertCursorContactsResponse(body);
      pagesFetched += 1;
      fetchedIds.push(...body.items.map((item) => item.id));
      nextCursor = body.nextCursor;
      hasMore = nextCursor !== null;
      events.push({
        type: "response",
        message: `Loaded cursor page ${body.cursor ?? "initial"} with ${body.items.length} contacts`
      });

      if (nextCursor !== null) {
        events.push({
          type: "pagination",
          message: `Following nextCursor=${nextCursor}`
        });
      }
    }
  }

  async function loadContactsPage(path: string): Promise<ContactsResponse> {
    let attempt = 0;

    while (true) {
      attempt += 1;
      requestCount += 1;
      events.push({
        type: "request",
        message: `GET ${path} (attempt ${attempt})`
      });

      const response = await fetch(`${server.baseUrl}${path}`, {
        headers: buildAuthHeaders(accessToken)
      });

      if (response.status === 401 && scenario.behavior.requiresAuth) {
        accessToken = await refreshAccessToken("refreshing expired bearer token");
        continue;
      }

      const responseBody: unknown = await response.json();

      if (response.status === 500) {
        transientErrorCount += 1;
        events.push({
          type: "response",
          message: `Received 500 from ${path}`
        });
        await retryOrThrow({
          attempt,
          maxRetries,
          delayMs: retryDelayMs,
          events,
          reason: "retrying after transient upstream failure",
          onRetry: () => {
            retryCount += 1;
          }
        });
        continue;
      }

      if (response.status === 429) {
        rateLimitCount += 1;
        const delayMs = getRetryDelayFromHeaders(response, retryDelayMs);
        events.push({
          type: "response",
          message: `Received 429 from ${path}`
        });
        await retryOrThrow({
          attempt,
          maxRetries,
          delayMs,
          events,
          reason: `waiting ${delayMs}ms for rate limit recovery`,
          onRetry: () => {
            retryCount += 1;
          }
        });
        continue;
      }

      if (!response.ok) {
        throw new Error(`Unexpected ${response.status} response while reading contacts.`);
      }

      assertContactsResponse(responseBody);
      return responseBody;
    }
  }

  async function syncContacts(): Promise<BatchSyncResponse> {
    requestCount += 1;
    events.push({
      type: "request",
      message: `POST /contacts/batch-sync for ${fetchedIds.length} contacts`
    });

    const response = await fetch(`${server.baseUrl}/contacts/batch-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(accessToken)
      },
      body: JSON.stringify({ ids: fetchedIds })
    });

    if (response.status === 401 && scenario.behavior.requiresAuth) {
      accessToken = await refreshAccessToken("refreshing bearer token before batch sync");
      return syncContacts();
    }

    if (!response.ok) {
      throw new Error(`Unexpected ${response.status} response while syncing contacts.`);
    }

    const batchBody: unknown = await response.json();
    assertBatchSyncResponse(batchBody);
    events.push({
      type: "response",
      message: batchBody.partial
        ? `Batch sync finished with ${batchBody.failed.length} item failures`
        : "Batch sync finished successfully"
    });

    return batchBody;
  }

  async function deliverWebhook(): Promise<void> {
    let attempt = 0;

    while (true) {
      attempt += 1;
      requestCount += 1;
      webhookAttemptCount += 1;
      events.push({
        type: "request",
        message: `POST /webhooks/outbound (attempt ${attempt})`
      });

      const response = await fetch(`${server.baseUrl}/webhooks/outbound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          eventId: `evt_${scenario.id}`,
          ids: fetchedIds
        })
      });

      if (response.status === 502) {
        webhookFailureCount += 1;
        events.push({
          type: "webhook",
          message: `Webhook receiver returned 502 on attempt ${attempt}`
        });
        await retryOrThrow({
          attempt,
          maxRetries,
          delayMs: retryDelayMs,
          events,
          reason: "retrying outbound webhook delivery",
          onRetry: () => {
            retryCount += 1;
            webhookRetryCount += 1;
          }
        });
        continue;
      }

      if (!response.ok) {
        throw new Error(`Unexpected ${response.status} response while delivering webhook.`);
      }

      const body: unknown = await response.json();
      assertWebhookDeliveryResponse(body);
      events.push({
        type: "webhook",
        message: `Webhook delivery accepted on attempt ${body.attempt}`
      });
      return;
    }
  }

  async function refreshAccessToken(reason: string): Promise<string> {
    authRefreshCount += 1;
    return requestAccessToken({
      baseUrl: server.baseUrl,
      events,
      requestCountUpdater: () => {
        requestCount += 1;
      },
      reason
    });
  }
}

function buildReport(report: SimulationReport): SimulationReport {
  return report;
}

async function requestAccessToken(args: {
  baseUrl: string;
  events: SimulationEvent[];
  requestCountUpdater: () => void;
  reason: string;
}): Promise<string> {
  const { baseUrl, events, requestCountUpdater, reason } = args;
  requestCountUpdater();
  events.push({
    type: "auth",
    message: `POST /auth/token (${reason})`
  });

  const response = await fetch(`${baseUrl}/auth/token`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Unexpected ${response.status} response while requesting an access token.`);
  }

  const body: unknown = await response.json();
  assertTokenResponse(body);
  events.push({
    type: "auth",
    message: `Received bearer token ${body.accessToken}`
  });
  return body.accessToken;
}

async function retryOrThrow(args: {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  events: SimulationEvent[];
  reason: string;
  onRetry: () => void;
}): Promise<void> {
  const { attempt, maxRetries, delayMs, events, reason, onRetry } = args;

  if (attempt > maxRetries) {
    throw new Error(`Exceeded max retries (${maxRetries}).`);
  }

  onRetry();
  events.push({
    type: "retry",
    message: `Retry ${attempt}/${maxRetries}: ${reason}`
  });

  await sleep(delayMs);
}

function buildAuthHeaders(accessToken: string | null): HeadersInit {
  if (accessToken === null) {
    return {};
  }

  return {
    Authorization: `Bearer ${accessToken}`
  };
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

function assertContactsResponse(value: unknown): asserts value is ContactsResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected contacts response to be an object.");
  }

  if (!("items" in value) || !Array.isArray(value.items) || !("paginationMode" in value)) {
    throw new Error("Contacts response is missing required pagination fields.");
  }
}

function assertOffsetContactsResponse(value: ContactsResponse): asserts value is Extract<ContactsResponse, { paginationMode: "page" }> {
  if (value.paginationMode !== "page" || !("page" in value) || !("nextPage" in value)) {
    throw new Error("Expected numbered page pagination fields in the contacts response.");
  }
}

function assertCursorContactsResponse(value: ContactsResponse): asserts value is Extract<ContactsResponse, { paginationMode: "cursor" }> {
  if (value.paginationMode !== "cursor" || !("nextCursor" in value) || !("cursor" in value)) {
    throw new Error("Expected cursor pagination fields in the contacts response.");
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

function assertTokenResponse(value: unknown): asserts value is TokenResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected token response to be an object.");
  }

  if (!("accessToken" in value) || typeof value.accessToken !== "string") {
    throw new Error("Token response is missing the access token.");
  }
}

function assertWebhookDeliveryResponse(value: unknown): asserts value is WebhookDeliveryResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected webhook response to be an object.");
  }

  if (!("accepted" in value) || typeof value.accepted !== "boolean" || !("attempt" in value)) {
    throw new Error("Webhook response is missing required delivery fields.");
  }
}
