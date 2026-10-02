import { HttpException } from "@nestjs/common";
import type {
  AdapterBinding,
  BindingEntry,
  CellStatus,
  EvidenceSuite,
  LedgerEntry,
  MatrixLedger,
  Observation,
  ObservedOutcome,
  Scenario,
  SuiteEntry,
} from "./matrix.types";
import { UnsupportedQuery } from "./world-db";

export interface Verdict {
  readonly status: CellStatus;
  readonly detail: string | null;
}

export function outcomeOfStatus(status: number): ObservedOutcome {
  if (status === 402) return "402";
  if (status === 403) return "403";
  if (status === 404) return "404";
  if (status >= 200 && status < 300) return "allow";
  return `unexpected:${status}`;
}

export function outcomeOfError(error: unknown): ObservedOutcome {
  if (error instanceof UnsupportedQuery) return `unexpected:${error.message}`;
  if (error instanceof HttpException) return outcomeOfStatus(error.getStatus());
  return `unexpected:${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
}

export async function settle(
  work: () => Promise<unknown>,
  checks: (value: unknown) => Readonly<Record<string, boolean>> = () => ({}),
): Promise<Observation> {
  try {
    const value = await work();
    return { outcome: "allow", checks: checks(value) };
  } catch (error: unknown) {
    return { outcome: outcomeOfError(error), checks: checks(undefined) };
  }
}

export function verdictOf(scenario: Scenario, observation: Observation): Verdict {
  const failedChecks = Object.entries(observation.checks ?? {})
    .filter(([, held]) => !held)
    .map(([name]) => name);
  if (observation.outcome === scenario.expected && failedChecks.length === 0) return { status: "proven", detail: null };
  const parts = [`expected ${scenario.expected}, observed ${observation.outcome}`];
  if (failedChecks.length > 0) parts.push(`failed checks: ${failedChecks.join(", ")}`);
  return { status: "failed", detail: parts.join("; ") };
}

export function bindingId(scenario: Scenario, binding: AdapterBinding): string {
  return `${scenario.id}@${binding.adapter}`;
}

export class MatrixRunner {
  private readonly scenarios = new Map<string, Scenario>();
  private readonly suites = new Map<string, EvidenceSuite>();
  private readonly results = new Map<string, Verdict>();
  private readonly suiteResults = new Map<string, Verdict>();

  declare(scenario: Scenario): void {
    if (this.scenarios.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    if (scenario.bindings.length === 0) throw new Error(`Scenario ${scenario.id} binds no adapter`);
    const adapters = scenario.bindings.map((binding) => binding.adapter);
    if (new Set(adapters).size !== adapters.length) throw new Error(`Scenario ${scenario.id} binds one adapter twice`);
    this.scenarios.set(scenario.id, scenario);
  }

  declareSuite(suite: EvidenceSuite): void {
    if (this.suites.has(suite.id)) throw new Error(`Duplicate suite id: ${suite.id}`);
    this.suites.set(suite.id, suite);
  }

  all(): readonly Scenario[] {
    return [...this.scenarios.values()];
  }

  find(id: string): Scenario | undefined {
    return this.scenarios.get(id);
  }

  async execute(scenario: Scenario, binding: AdapterBinding): Promise<Verdict> {
    let verdict: Verdict;
    try {
      verdict = verdictOf(scenario, await binding.run());
    } catch (error: unknown) {
      verdict = { status: "failed", detail: `adapter threw: ${outcomeOfError(error)}` };
    }
    this.results.set(bindingId(scenario, binding), verdict);
    return verdict;
  }

  recordSuite(id: string, verdict: Verdict): void {
    if (!this.suites.has(id)) throw new Error(`Unknown suite id: ${id}`);
    this.suiteResults.set(id, verdict);
  }

  ledger(): MatrixLedger {
    const bindings: BindingEntry[] = this.all().flatMap((scenario) =>
      scenario.bindings.map((binding): BindingEntry => {
        const id = bindingId(scenario, binding);
        const result = this.results.get(id) ?? { status: "unrun", detail: null };
        return {
          kind: "binding",
          id,
          scenario: scenario.id,
          adapter: binding.adapter,
          entry: binding.entry,
          actor: scenario.actor,
          resource: scenario.resource,
          action: scenario.action,
          tenant: scenario.tenant,
          state: scenario.state,
          expected: scenario.expected,
          pairedWith: scenario.pairedWith ?? null,
          covers: scenario.covers ?? [],
          required: true,
          status: result.status,
          detail: result.detail,
        };
      }),
    );
    const suites: SuiteEntry[] = [...this.suites.values()].map((suite) => {
      const result = this.suiteResults.get(suite.id);
      return {
        kind: "suite",
        id: suite.id,
        resource: suite.resource,
        suite: suite.suite,
        required: suite.runnable,
        status: result?.status ?? "unrun",
        detail: result?.detail ?? (suite.runnable ? null : suite.reason),
      };
    });
    const entries: LedgerEntry[] = [...bindings, ...suites];
    const count = (status: CellStatus): number => entries.filter((entry) => entry.status === status).length;
    return {
      version: 2,
      generatedAt: new Date().toISOString(),
      scenarios: this.scenarios.size,
      proven: count("proven"),
      failed: count("failed"),
      unrun: count("unrun"),
      total: entries.length,
      entries,
    };
  }
}
