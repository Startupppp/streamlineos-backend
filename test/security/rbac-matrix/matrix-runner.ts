/**
 * MatrixRunner — collects declared cells and their run results, then builds
 * the release ledger.
 *
 * Usage within a jest spec:
 *
 *   const runner = new MatrixRunner();
 *   runner.declare(cell);
 *   // … run the cell in an `it()` block and call runner.record(…) …
 *   afterAll(() => { const l = runner.ledger(); expect(l.unrun).toBe(0); });
 *
 * A cell declared but never passed to `record()` becomes "unrun" in the ledger,
 * which is the visible gap the release question requires.
 */

import type {
  ScenarioCell,
  CellRunResult,
  CellRunStatus,
  MatrixLedger,
} from "./matrix.types";

export class MatrixRunner {
  private readonly cells: ScenarioCell[] = [];
  private readonly results = new Map<string, CellRunResult>();

  declare(cell: ScenarioCell): void {
    if (this.cells.some((c) => c.id === cell.id)) {
      throw new Error(`MatrixRunner: duplicate cell id "${cell.id}"`);
    }
    this.cells.push(cell);
  }

  record(cellId: string, status: CellRunStatus, detail?: string): void {
    this.results.set(cellId, { cellId, status, detail });
  }

  ledger(): MatrixLedger {
    const results: CellRunResult[] = this.cells.map((cell) => {
      const stored = this.results.get(cell.id);
      if (!stored) return { cellId: cell.id, status: "unrun" as CellRunStatus };
      return stored;
    });

    return {
      cells: [...this.cells],
      results,
      proven: results.filter((r) => r.status === "proven").length,
      failed: results.filter((r) => r.status === "failed").length,
      unrun: results.filter((r) => r.status === "unrun").length,
    };
  }
}
