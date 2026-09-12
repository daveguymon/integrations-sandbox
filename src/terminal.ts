import { type ScenarioDefinition } from "./scenarios.js";
import { type SimulationReport } from "./simulator.js";

export function formatScenarioList(items: ScenarioDefinition[]): string {
  return [
    "Available scenarios:",
    ...items.map(
      (scenario) =>
        `- ${scenario.id}: ${scenario.title} — ${scenario.description}`
    )
  ].join("\n");
}

export function formatSimulationReport(report: SimulationReport): string {
  const statusLabel = report.partial ? "partial-failure" : "success";
  const failedSummary =
    report.failedIds.length > 0 ? report.failedIds.join(", ") : "none";

  return [
    `Scenario: ${report.scenarioId} (${report.scenarioTitle})`,
    `Outcome: ${statusLabel}`,
    `Requests: ${report.requestCount}`,
    `Retries: ${report.retryCount} (500s: ${report.transientErrorCount}, 429s: ${report.rateLimitCount})`,
    `Pages fetched: ${report.pagesFetched}`,
    `Contacts fetched: ${report.contactsFetched}`,
    `Accepted IDs: ${report.acceptedIds.length}`,
    `Failed IDs: ${failedSummary}`,
    "",
    "Trace:",
    ...report.events.map((event, index) => `${index + 1}. [${event.type}] ${event.message}`)
  ].join("\n");
}

export function formatServeBanner(args: {
  scenarioId: string;
  baseUrl: string;
}): string {
  return [
    `Sandbox server ready for scenario "${args.scenarioId}"`,
    `Base URL: ${args.baseUrl}`,
    "Endpoints:",
    "  GET  /health",
    "  GET  /contacts?page=1&pageSize=2",
    "  POST /contacts/batch-sync",
    "",
    "Try it with:",
    `  curl ${args.baseUrl}/contacts?page=1&pageSize=2 | cat`,
    `  curl -X POST ${args.baseUrl}/contacts/batch-sync -H 'Content-Type: application/json' -d '{\"ids\":[\"contact_1\",\"contact_2\"]}' | cat`
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
    "      Start a temporary local sandbox, run a paginated sync, and print a request trace.",
    "  serve --scenario <id> [--port <n>]",
    "      Start a persistent local mock service so you can test it with curl or another client.",
    "",
    "Examples:",
    "  npm run cli -- list",
    "  npm run cli -- simulate --scenario flaky-retries",
    "  npm run cli -- serve --scenario mixed-chaos --port 4010"
  ].join("\n");
}
