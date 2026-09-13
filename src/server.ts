import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { getScenarioOrThrow, type Contact, type PaginationMode, type ScenarioDefinition } from "./scenarios.js";

interface BaseContactsResponse {
  scenario: string;
  service: string;
  paginationMode: PaginationMode;
  pageSize: number;
  total: number;
  items: Contact[];
}

export interface OffsetContactsPageResponse extends BaseContactsResponse {
  paginationMode: "page";
  page: number;
  nextPage: number | null;
}

export interface CursorContactsResponse extends BaseContactsResponse {
  paginationMode: "cursor";
  cursor: string | null;
  nextCursor: string | null;
}

export type ContactsResponse = OffsetContactsPageResponse | CursorContactsResponse;

export interface BatchSyncRequest {
  ids: string[];
}

export interface BatchSyncResponse {
  scenario: string;
  service: string;
  received: number;
  acceptedIds: string[];
  failed: Array<{ id: string; reason: string }>;
  partial: boolean;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: "Bearer";
  expiresInSeconds: number;
}

export interface WebhookDeliveryRequest {
  eventId: string;
  ids: string[];
}

export interface WebhookDeliveryResponse {
  scenario: string;
  service: string;
  eventId: string;
  accepted: boolean;
  attempt: number;
}

export interface SandboxRequestLog {
  method: string;
  path: string;
  statusCode: number;
  scenarioId: string;
}

export interface SandboxServerOptions {
  scenarioId: string;
  port?: number;
  onRequestLog?: (entry: SandboxRequestLog) => void;
}

export interface RunningSandboxServer {
  scenario: ScenarioDefinition;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

interface ScenarioRuntimeState {
  contactsAttemptCount: number;
  contactsSuccessCount: number;
  batchAttemptCount: number;
  webhookAttemptCount: number;
  tokenIssueCount: number;
  firstTokenExpired: boolean;
}

export function createSandboxServer(options: SandboxServerOptions): Promise<RunningSandboxServer> {
  const scenario = getScenarioOrThrow(options.scenarioId);
  const state: ScenarioRuntimeState = {
    contactsAttemptCount: 0,
    contactsSuccessCount: 0,
    batchAttemptCount: 0,
    webhookAttemptCount: 0,
    tokenIssueCount: 0,
    firstTokenExpired: false
  };

  const server = createServer((request, response) => {
    handleRequest({
      request,
      response,
      scenario,
      state,
      onRequestLog: options.onRequestLog
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unexpected sandbox server error";
      sendJson(response, 500, { error: message });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("Unable to determine sandbox server address."));
        return;
      }

      resolve({
        scenario,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        stop: () => closeServer(server)
      });
    });
  });
}

async function handleRequest(args: {
  request: IncomingMessage;
  response: ServerResponse;
  scenario: ScenarioDefinition;
  state: ScenarioRuntimeState;
  onRequestLog?: (entry: SandboxRequestLog) => void;
}): Promise<void> {
  const { request, response, scenario, state, onRequestLog } = args;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = `${url.pathname}${url.search}`;

  if (method === "GET" && url.pathname === "/health") {
    sendLoggedJson(response, 200, { ok: true, scenario: scenario.id }, method, path, scenario.id, onRequestLog);
    return;
  }

  if (method === "POST" && url.pathname === "/auth/token") {
    state.tokenIssueCount += 1;
    const payload: TokenResponse = {
      accessToken: issueAccessToken(state.tokenIssueCount),
      tokenType: "Bearer",
      expiresInSeconds: scenario.behavior.authExpiresFirstToken && state.tokenIssueCount === 1 ? 0 : 3600
    };

    sendLoggedJson(response, 200, payload, method, path, scenario.id, onRequestLog);
    return;
  }

  if (method === "GET" && url.pathname === "/contacts") {
    if (rejectUnauthorizedRequest({ request, response, scenario, state, method, path, onRequestLog })) {
      return;
    }

    state.contactsAttemptCount += 1;
    const statusOverride = getListFailureStatus(scenario, state.contactsAttemptCount);

    if (statusOverride === 500) {
      sendLoggedJson(
        response,
        500,
        {
          error: "Upstream transient failure",
          retryable: true,
          attempt: state.contactsAttemptCount
        },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    if (statusOverride === 429) {
      response.setHeader("Retry-After", "1");
      response.setHeader("X-Retry-After-Ms", "25");
      sendLoggedJson(
        response,
        429,
        {
          error: "Upstream rate limit exceeded",
          retryable: true,
          attempt: state.contactsAttemptCount
        },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    const pageSize = parsePositiveInteger(
      url.searchParams.get("pageSize"),
      scenario.defaultPageSize,
      "pageSize"
    );
    const payload = buildContactsResponse({ scenario, url, pageSize });
    state.contactsSuccessCount += 1;

    if (scenario.behavior.malformedContactsSuccessNumber === state.contactsSuccessCount) {
      sendLoggedJson(
        response,
        200,
        {
          scenario: scenario.id,
          service: scenario.serviceName,
          paginationMode: scenario.behavior.paginationMode,
          total: scenario.contacts.length,
          brokenItems: payload.items
        },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    sendLoggedJson(response, 200, payload, method, path, scenario.id, onRequestLog);
    return;
  }

  if (method === "POST" && url.pathname === "/contacts/batch-sync") {
    if (rejectUnauthorizedRequest({ request, response, scenario, state, method, path, onRequestLog })) {
      return;
    }

    state.batchAttemptCount += 1;
    const body = await readJsonBody(request);

    if (!isBatchSyncRequest(body)) {
      sendLoggedJson(
        response,
        400,
        { error: "Request body must be JSON with an ids array." },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    const failed = body.ids
      .filter((id) => scenario.behavior.partialFailureIds.includes(id))
      .map((id) => ({ id, reason: "Simulated downstream rejection" }));
    const acceptedIds = body.ids.filter((id) => !scenario.behavior.partialFailureIds.includes(id));
    const payload: BatchSyncResponse = {
      scenario: scenario.id,
      service: scenario.serviceName,
      received: body.ids.length,
      acceptedIds,
      failed,
      partial: failed.length > 0
    };

    sendLoggedJson(response, 200, payload, method, path, scenario.id, onRequestLog);
    return;
  }

  if (method === "POST" && url.pathname === "/webhooks/outbound") {
    state.webhookAttemptCount += 1;
    const body = await readJsonBody(request);

    if (!isWebhookDeliveryRequest(body)) {
      sendLoggedJson(
        response,
        400,
        { error: "Request body must be JSON with eventId and ids fields." },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    if (state.webhookAttemptCount <= scenario.behavior.webhookFailuresBeforeSuccess) {
      sendLoggedJson(
        response,
        502,
        {
          error: "Webhook receiver temporary failure",
          retryable: true,
          attempt: state.webhookAttemptCount
        },
        method,
        path,
        scenario.id,
        onRequestLog
      );
      return;
    }

    const payload: WebhookDeliveryResponse = {
      scenario: scenario.id,
      service: scenario.serviceName,
      eventId: body.eventId,
      accepted: true,
      attempt: state.webhookAttemptCount
    };

    sendLoggedJson(response, 202, payload, method, path, scenario.id, onRequestLog);
    return;
  }

  sendLoggedJson(response, 404, { error: "Route not found" }, method, path, scenario.id, onRequestLog);
}

function rejectUnauthorizedRequest(args: {
  request: IncomingMessage;
  response: ServerResponse;
  scenario: ScenarioDefinition;
  state: ScenarioRuntimeState;
  method: string;
  path: string;
  onRequestLog?: (entry: SandboxRequestLog) => void;
}): boolean {
  const { request, response, scenario, state, method, path, onRequestLog } = args;

  if (!scenario.behavior.requiresAuth) {
    return false;
  }

  const authHeader = request.headers.authorization;
  const tokenVersion = parseBearerTokenVersion(authHeader);

  if (tokenVersion === null) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="sandbox", error="invalid_token"');
    sendLoggedJson(
      response,
      401,
      { error: "Missing or invalid bearer token", retryable: false },
      method,
      path,
      scenario.id,
      onRequestLog
    );
    return true;
  }

  if (scenario.behavior.authExpiresFirstToken && tokenVersion === 1 && !state.firstTokenExpired) {
    state.firstTokenExpired = true;
    response.setHeader("WWW-Authenticate", 'Bearer realm="sandbox", error="invalid_token", error_description="expired"');
    sendLoggedJson(
      response,
      401,
      { error: "Bearer token expired", retryable: true },
      method,
      path,
      scenario.id,
      onRequestLog
    );
    return true;
  }

  if (tokenVersion > state.tokenIssueCount) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="sandbox", error="invalid_token"');
    sendLoggedJson(
      response,
      401,
      { error: "Unknown bearer token", retryable: false },
      method,
      path,
      scenario.id,
      onRequestLog
    );
    return true;
  }

  return false;
}

function buildContactsResponse(args: {
  scenario: ScenarioDefinition;
  url: URL;
  pageSize: number;
}): ContactsResponse {
  const { scenario, url, pageSize } = args;

  if (scenario.behavior.paginationMode === "cursor") {
    const cursor = url.searchParams.get("cursor");
    const startIndex = parseCursor(cursor);
    const items = scenario.contacts.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + pageSize;

    return {
      scenario: scenario.id,
      service: scenario.serviceName,
      paginationMode: "cursor",
      cursor,
      pageSize,
      total: scenario.contacts.length,
      items,
      nextCursor: nextIndex < scenario.contacts.length ? encodeCursor(nextIndex) : null
    };
  }

  const page = parsePositiveInteger(url.searchParams.get("page"), 1, "page");
  const startIndex = (page - 1) * pageSize;
  const items = scenario.contacts.slice(startIndex, startIndex + pageSize);
  const nextPage = startIndex + pageSize < scenario.contacts.length ? page + 1 : null;

  return {
    scenario: scenario.id,
    service: scenario.serviceName,
    paginationMode: "page",
    page,
    pageSize,
    total: scenario.contacts.length,
    items,
    nextPage
  };
}

function getListFailureStatus(scenario: ScenarioDefinition, attempt: number): 429 | 500 | null {
  if (attempt <= scenario.behavior.serverErrorsBeforeSuccess) {
    return 500;
  }

  const rateLimitWindowEnd =
    scenario.behavior.serverErrorsBeforeSuccess + scenario.behavior.rateLimitsBeforeSuccess;

  if (attempt <= rateLimitWindowEnd) {
    return 429;
  }

  return null;
}

function parsePositiveInteger(rawValue: string | null, fallback: number, label: string): number {
  if (rawValue === null) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid ${label} "${rawValue}". Expected a positive integer.`);
  }

  return parsedValue;
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }

  const match = /^cursor_(\d+)$/.exec(cursor);

  if (!match) {
    throw new Error(`Invalid cursor "${cursor}". Expected the sandbox cursor format.`);
  }

  return Number.parseInt(match[1], 10);
}

function encodeCursor(index: number): string {
  return `cursor_${index}`;
}

function issueAccessToken(issueCount: number): string {
  return `sandbox-token-v${issueCount}`;
}

function parseBearerTokenVersion(authorizationHeader: string | undefined): number | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = /^Bearer sandbox-token-v(\d+)$/.exec(authorizationHeader);

  if (!match) {
    return null;
  }

  return Number.parseInt(match[1], 10);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isBatchSyncRequest(value: unknown): value is BatchSyncRequest {
  if (typeof value !== "object" || value === null || !("ids" in value)) {
    return false;
  }

  const ids = value.ids;
  return Array.isArray(ids) && ids.every((entry) => typeof entry === "string");
}

function isWebhookDeliveryRequest(value: unknown): value is WebhookDeliveryRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("eventId" in value) ||
    !("ids" in value)
  ) {
    return false;
  }

  return typeof value.eventId === "string" && Array.isArray(value.ids) && value.ids.every((entry) => typeof entry === "string");
}

function sendLoggedJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  method: string,
  path: string,
  scenarioId: string,
  onRequestLog?: (entry: SandboxRequestLog) => void
): void {
  onRequestLog?.({ method, path, statusCode, scenarioId });
  sendJson(response, statusCode, payload);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
