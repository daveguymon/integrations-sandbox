#!/usr/bin/env node

import { listScenarios, getScenarioOrThrow } from "./scenarios.js";
import { createSandboxServer } from "./server.js";
import { simulateScenario } from "./simulator.js";
import {
  formatHelpText,
  formatScenarioList,
  formatServeBanner,
  formatSimulationReport
} from "./terminal.js";

interface ParsedArgs {
  command: string | undefined;
  options: Record<string, string>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.command ?? "help";

  switch (command) {
    case "list": {
      console.log(formatScenarioList(listScenarios()));
      return;
    }

    case "simulate": {
      const scenarioId = getRequiredOption(parsed.options, "scenario");
      getScenarioOrThrow(scenarioId);
      const maxRetries = parseNumberOption(parsed.options.maxRetries, 4, "max-retries");
      const report = await simulateScenario({
        scenarioId,
        maxRetries
      });
      console.log(formatSimulationReport(report));
      process.exitCode = report.partial ? 2 : 0;
      return;
    }

    case "serve": {
      const scenarioId = getRequiredOption(parsed.options, "scenario");
      getScenarioOrThrow(scenarioId);
      const port = parseNumberOption(parsed.options.port, 4010, "port");
      const server = await createSandboxServer({
        scenarioId,
        port,
        onRequestLog: (entry) => {
          console.log(`[server] ${entry.method} ${entry.path} -> ${entry.statusCode}`);
        }
      });
      console.log(formatServeBanner({ scenarioId, baseUrl: server.baseUrl }));

      const shutdown = async (): Promise<void> => {
        console.log("\nShutting down sandbox server...");
        await server.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => {
        void shutdown();
      });
      process.on("SIGTERM", () => {
        void shutdown();
      });

      await new Promise<void>(() => undefined);
      return;
    }

    case "help":
    default:
      console.log(formatHelpText());
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const options: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument "${token}".`);
    }

    const key = toCamelCase(token.slice(2));
    const value = rest[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option "${token}".`);
    }

    options[key] = value;
    index += 1;
  }

  return { command, options };
}

function toCamelCase(input: string): string {
  return input.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function getRequiredOption(options: Record<string, string>, key: string): string {
  const value = options[key];

  if (!value) {
    throw new Error(`Missing required --${toKebabCase(key)} option.`);
  }

  return value;
}

function parseNumberOption(rawValue: string | undefined, fallback: number, label: string): number {
  if (!rawValue) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid --${label} value "${rawValue}". Expected a positive integer.`);
  }

  return parsedValue;
}

function toKebabCase(input: string): string {
  return input.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected CLI error";
  console.error(message);
  process.exit(1);
});
