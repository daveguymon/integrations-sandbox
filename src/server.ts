import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { getScenarioOrThrow, type Contact, type ScenarioDefinition } from "./scenarios.js";

export interface ContactsPageResponse {
  scenario: string;
  service: string;
  page: number;
  pageSize: number;
  total: number;
  items: Contact[];
  nextPage: number | null;
}

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
  batchAttemptCount: number;
}

export function createSandboxServer(options: SandboxServerOptions): Promise<RunningSandboxServer> {
  const scenario = getScenarioOrThrow(options.scenarioId);
  const state: ScenarioRuntimeState = {
    contactsAttemptCount: 0,
    batchAttemptCount: 0
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

  if (method === "GET" && url.pathname === "/contacts") {
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

    const page = parsePositiveInteger(url.searchParams.get("page"), 1, "page");
    const pageSize = parsePositiveInteger(
      url.searchParams.get("pageSize"),
      scenario.defaultPageSize,
      "pageSize"
    );
    const startIndex = (page - 1) * pageSize;
    const items = scenario.contacts.slice(startIndex, startIndex + pageSize);
    const nextPage = startIndex + pageSize < scenario.contacts.length ? page + 1 : null;
    const payload: ContactsPageResponse = {
      scenario: scenario.id,
      service: scenario.serviceName,
      page,
      pageSize,
      total: scenario.contacts.length,
      items,
      nextPage
    };

    sendLoggedJson(response, 200, payload, method, path, scenario.id, onRequestLog);
    return;
  }

  if (method === "POST" && url.pathname === "/contacts/batch-sync") {
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

  sendLoggedJson(response, 404, { error: "Route not found" }, method, path, scenario.id, onRequestLog);
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
