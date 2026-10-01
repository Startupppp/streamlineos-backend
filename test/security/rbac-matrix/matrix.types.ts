import type { Standing } from "./standings";

export type ExpectedOutcome = "allow" | "403" | "404" | "402";
export type ObservedOutcome = ExpectedOutcome | `unexpected:${string}`;
export type AdapterKind = "http" | "realtime" | "job" | "file" | "service";
export type CellState = "normal" | "module-disabled" | "cross-project" | "scope-narrowed" | "replayed";

export interface Observation {
  readonly outcome: ObservedOutcome;
  readonly checks?: Readonly<Record<string, boolean>>;
}

export interface ExecutableCell {
  readonly kind: "executable";
  readonly id: string;
  readonly standing: Standing;
  readonly resource: string;
  readonly action: string;
  readonly tenant: "same" | "other";
  readonly state: CellState;
  readonly expected: ExpectedOutcome;
  readonly adapter: AdapterKind;
  readonly because: string;
  readonly pairedWith?: string;
  readonly run: () => Promise<Observation>;
}

export interface DeclaredCell {
  readonly kind: "declared";
  readonly id: string;
  readonly resource: string;
  readonly evidenceSuite: string;
}

export type MatrixCell = ExecutableCell | DeclaredCell;

export type CellStatus = "proven" | "failed" | "unrun";

export interface LedgerEntry {
  readonly id: string;
  readonly kind: MatrixCell["kind"];
  readonly required: boolean;
  readonly status: CellStatus;
  readonly adapter: AdapterKind | null;
  readonly standing: Standing | null;
  readonly expected: ExpectedOutcome | null;
  readonly evidenceSuite: string | null;
  readonly detail: string | null;
}

export interface MatrixLedger {
  readonly version: 1;
  readonly proven: number;
  readonly failed: number;
  readonly unrun: number;
  readonly total: number;
  readonly entries: readonly LedgerEntry[];
}
