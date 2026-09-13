import { type ScenarioDefinition } from "./scenarios.js";
import { type SimulationReport } from "./simulator.js";

export function formatScenarioList(items: ScenarioDefinition[]): string {
  return [
    "Available scenarios:",
    ...items.map(
      (scenario) =>
        `- ${scenario.id}: ${scenario.title} [pagination=${scenario.behavior.paginationMode}] — ${scenario.description}`
    )
  ].join("\n");
}

export function formatSimulationReport(report: SimulationReport): string {
  const statusLabel = report.errorMessage !== null ? "error" : report.partial ? "partial-failure" : "success";
  const failedSummary = report.failedIds.length > 0 ? report.failedIds.join(", ") : "none";

  return [
    `Scenario: ${report.scenarioId} (${report.scenarioTitle})`,
    `Outcome: ${statusLabel}`,
    `Pagination mode: ${report.paginationMode}`,
    `Requests: ${report.requestCount}`,
    `Retries: ${report.retryCount} (500s: ${report.transientErrorCount}, 429s: ${report.rateLimitCount})`,
    `Auth refreshes: ${report.authRefreshCount}`,
    `Webhook attempts: ${report.webhookAttemptCount} (retries: ${report.webhookRetryCount}, failures: ${report.webhookFailureCount})`,
    `Pages fetched: ${report.pagesFetched}`,
    `Contacts fetched: ${report.contactsFetched}`,
    `Accepted IDs: ${report.acceptedIds.length}`,
    `Failed IDs: ${failedSummary}`,
    ...(report.errorMessage !== null ? [`Error: ${report.errorMessage}`] : []),
    "",
    "Trace:",
    ...report.events.map((event, index) => `${index + 1}. [${event.type}] ${event.message}`)
  ].join("\n");
}

export function formatServeBanner(args: {
  scenario: ScenarioDefinition;
  baseUrl: string;
}): string {
  const contactsExample =
    args.scenario.behavior.paginationMode === "cursor"
      ? `  curl ${args.baseUrl}/contacts?pageSize=${args.scenario.defaultPageSize} | cat`
      : `  curl ${args.baseUrl}/contacts?page=1&pageSize=${args.scenario.defaultPageSize} | cat`;
  const authExample = args.scenario.behavior.requiresAuth
    ? `  curl -X POST ${args.baseUrl}/auth/token | cat`
    : null;

  return [
    `Sandbox server ready for scenario "${args.scenario.id}"`,
    `Base URL: ${args.baseUrl}`,
    `Pagination mode: ${args.scenario.behavior.paginationMode}`,
    `Auth required: ${args.scenario.behavior.requiresAuth ? "yes" : "no"}`,
    "Endpoints:",
    "  GET  /health",
    "  POST /auth/token",
    "  GET  /contacts?page=1&pageSize=2",
    "  GET  /contacts?pageSize=2&cursor=cursor_2",
    "  POST /contacts/batch-sync",
    "  POST /webhooks/outbound",
    "",
    "Try it with:",
    `  curl ${args.baseUrl}/health | cat`,
    ...(authExample ? [authExample] : []),
    contactsExample,
    `  curl -X POST ${args.baseUrl}/contacts/batch-sync -H 'Content-Type: application/json' -d '{\"ids\":[\"contact_1\",\"contact_2\"]}' | cat`,
    `  curl -X POST ${args.baseUrl}/webhooks/outbound -H 'Content-Type: application/json' -d '{\"eventId\":\"evt_manual\",\"ids\":[\"contact_1\"]}' | cat`
  ].join("\n");
}

export function formatHelpText(): string {
  return [
    "Integration Sandbox CLI",
    "",
    "Commands:",
    "  list",
    "      List available integration scenarios.",
    "  simulate --scenario <id> [--max-retries <n>]",
    "      Start a temporary local sandbox, run the scenario flow, and print a request trace.",
    "  serve --scenario <id> [--port <n>]",
    "      Start a persistent local mock service so you can test it with curl or another client.",
    "",
    "Examples:",
    "  npm run cli -- list",
    "  npm run cli -- simulate --scenario auth-expiry",
    "  npm run cli -- serve --scenario cursor-pagination --port 4010"
  ].join("\n");
}
