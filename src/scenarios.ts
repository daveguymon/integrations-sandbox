export interface Contact {
  id: string;
  name: string;
  email: string;
}

export interface ScenarioBehavior {
  serverErrorsBeforeSuccess: number;
  rateLimitsBeforeSuccess: number;
  partialFailureIds: string[];
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  description: string;
  serviceName: string;
  defaultPageSize: number;
  contacts: Contact[];
  behavior: ScenarioBehavior;
}

const CONTACT_FIXTURE: Contact[] = [
  { id: "contact_1", name: "Ada Lovelace", email: "ada@example.test" },
  { id: "contact_2", name: "Grace Hopper", email: "grace@example.test" },
  { id: "contact_3", name: "Margaret Hamilton", email: "margaret@example.test" },
  { id: "contact_4", name: "Radia Perlman", email: "radia@example.test" },
  { id: "contact_5", name: "Katherine Johnson", email: "katherine@example.test" },
  { id: "contact_6", name: "Annie Easley", email: "annie@example.test" }
];

export const scenarios: ScenarioDefinition[] = [
  {
    id: "happy-path",
    title: "Happy path",
    description: "Clean paginated reads followed by a fully successful batch sync.",
    serviceName: "sandbox-crm",
    defaultPageSize: 2,
    contacts: CONTACT_FIXTURE,
    behavior: {
      serverErrorsBeforeSuccess: 0,
      rateLimitsBeforeSuccess: 0,
      partialFailureIds: []
    }
  },
  {
    id: "flaky-retries",
    title: "Transient 500s",
    description: "The first two list requests fail with 500 so the client must retry.",
    serviceName: "sandbox-crm",
    defaultPageSize: 2,
    contacts: CONTACT_FIXTURE,
    behavior: {
      serverErrorsBeforeSuccess: 2,
      rateLimitsBeforeSuccess: 0,
      partialFailureIds: []
    }
  },
  {
    id: "rate-limit-recover",
    title: "Rate limit recovery",
    description: "The first list request returns 429 with retry hints before succeeding.",
    serviceName: "sandbox-crm",
    defaultPageSize: 2,
    contacts: CONTACT_FIXTURE,
    behavior: {
      serverErrorsBeforeSuccess: 0,
      rateLimitsBeforeSuccess: 1,
      partialFailureIds: []
    }
  },
  {
    id: "partial-batch-failure",
    title: "Partial batch failure",
    description: "Reads succeed, but batch sync returns item-level failures for selected contacts.",
    serviceName: "sandbox-crm",
    defaultPageSize: 2,
    contacts: CONTACT_FIXTURE,
    behavior: {
      serverErrorsBeforeSuccess: 0,
      rateLimitsBeforeSuccess: 0,
      partialFailureIds: ["contact_2", "contact_5"]
    }
  },
  {
    id: "mixed-chaos",
    title: "Mixed chaos",
    description: "One 500, one 429, paginated reads, then a partial batch failure.",
    serviceName: "sandbox-crm",
    defaultPageSize: 2,
    contacts: CONTACT_FIXTURE,
    behavior: {
      serverErrorsBeforeSuccess: 1,
      rateLimitsBeforeSuccess: 1,
      partialFailureIds: ["contact_5"]
    }
  }
];

export function listScenarios(): ScenarioDefinition[] {
  return scenarios;
}

export function getScenarioOrThrow(scenarioId: string): ScenarioDefinition {
  const scenario = scenarios.find((candidate) => candidate.id === scenarioId);

  if (!scenario) {
    const available = scenarios.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown scenario "${scenarioId}". Available scenarios: ${available}`);
  }

  return scenario;
}
