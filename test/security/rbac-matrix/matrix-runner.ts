import { HttpException } from "@nestjs/common";
import type {
  CellStatus,
  ExecutableCell,
  LedgerEntry,
  MatrixCell,
  MatrixLedger,
  Observation,
  ObservedOutcome,
} from "./matrix.types";

export function outcomeOfStatus(status: number): ObservedOutcome {
  if (status === 402) return "402";
  if (status === 403) return "403";
  if (status === 404) return "404";
  if (status >= 200 && status < 300) return "allow";
  return `unexpected:${status}`;
}

export function outcomeOfError(error: unknown): ObservedOutcome {
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

export function verdictOf(cell: ExecutableCell, observation: Observation): { status: CellStatus; detail: string | null } {
  const failedChecks = Object.entries(observation.checks ?? {})
    .filter(([, held]) => !held)
    .map(([name]) => name);
  if (observation.outcome === cell.expected && failedChecks.length === 0) return { status: "proven", detail: null };
  const parts = [`expected ${cell.expected}, observed ${observation.outcome}`];
  if (failedChecks.length > 0) parts.push(`failed checks: ${failedChecks.join(", ")}`);
  return { status: "failed", detail: parts.join("; ") };
}

export class MatrixRunner {
  private readonly cells = new Map<string, MatrixCell>();
  private readonly results = new Map<string, { status: CellStatus; detail: string | null }>();

  declare(cell: MatrixCell): void {
    if (this.cells.has(cell.id)) throw new Error(`Duplicate cell id: ${cell.id}`);
    this.cells.set(cell.id, cell);
  }

  all(): readonly MatrixCell[] {
    return [...this.cells.values()];
  }

  executable(): readonly ExecutableCell[] {
    return this.all().filter((cell): cell is ExecutableCell => cell.kind === "executable");
  }

  find(id: string): MatrixCell | undefined {
    return this.cells.get(id);
  }

  async execute(cell: ExecutableCell): Promise<{ status: CellStatus; detail: string | null }> {
    let verdict: { status: CellStatus; detail: string | null };
    try {
      verdict = verdictOf(cell, await cell.run());
    } catch (error: unknown) {
      verdict = { status: "failed", detail: `adapter threw: ${outcomeOfError(error)}` };
    }
    this.results.set(cell.id, verdict);
    return verdict;
  }

  ledger(): MatrixLedger {
    const entries: LedgerEntry[] = this.all().map((cell) => {
      const result = this.results.get(cell.id) ?? { status: "unrun", detail: null };
      return {
        id: cell.id,
        kind: cell.kind,
        required: cell.kind === "executable",
        status: result.status,
        adapter: cell.kind === "executable" ? cell.adapter : null,
        standing: cell.kind === "executable" ? cell.standing : null,
        expected: cell.kind === "executable" ? cell.expected : null,
        evidenceSuite: cell.kind === "declared" ? cell.evidenceSuite : null,
        detail: result.detail,
      };
    });
    const count = (status: CellStatus): number => entries.filter((entry) => entry.status === status).length;
    return {
      version: 1,
      proven: count("proven"),
      failed: count("failed"),
      unrun: count("unrun"),
      total: entries.length,
      entries,
    };
  }
}
