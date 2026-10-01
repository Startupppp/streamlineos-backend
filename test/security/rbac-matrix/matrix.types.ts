import type { Standing } from "./standings";

export type ExpectedOutcome = "allow" | "403" | "404" | "402";
export type ObservedOutcome = ExpectedOutcome | `unexpected:${string}`;
export type AdapterKind = "http" | "realtime" | "job" | "file" | "service";
export type ScenarioActor = Standing | "tenant-only";
export type ScenarioState =
  | "normal"
  | "module-disabled"
  | "cross-project"
  | "scope-narrowed"
  | "replayed"
  | "suspended-membership"
  | "removed-membership"
  | "expired-role"
  | "soft-deleted-parent"
  | "archived-project";

export interface Observation {
  readonly outcome: ObservedOutcome;
  readonly checks?: Readonly<Record<string, boolean>>;
}

export interface AdapterBinding {
  readonly adapter: AdapterKind;
  readonly entry: string;
  readonly run: () => Promise<Observation>;
}

export interface Scenario {
  readonly id: string;
  readonly actor: ScenarioActor;
  readonly resource: string;
  readonly action: string;
  readonly tenant: "same" | "other";
  readonly state: ScenarioState;
  readonly expected: ExpectedOutcome;
  readonly because: string;
  readonly pairedWith?: string;
  readonly covers?: readonly string[];
  readonly bindings: readonly AdapterBinding[];
}

export interface EvidenceSuite {
  readonly id: string;
  readonly resource: string;
  readonly suite: string;
  readonly runnable: boolean;
  readonly reason: string;
}

export type CellStatus = "proven" | "failed" | "unrun";

export interface BindingEntry {
  readonly kind: "binding";
  readonly id: string;
  readonly scenario: string;
  readonly adapter: AdapterKind;
  readonly entry: string;
  readonly actor: ScenarioActor;
  readonly resource: string;
  readonly action: string;
  readonly tenant: "same" | "other";
  readonly state: ScenarioState;
  readonly expected: ExpectedOutcome;
  readonly pairedWith: string | null;
  readonly covers: readonly string[];
  readonly required: true;
  readonly status: CellStatus;
  readonly detail: string | null;
}

export interface SuiteEntry {
  readonly kind: "suite";
  readonly id: string;
  readonly resource: string;
  readonly suite: string;
  readonly required: boolean;
  readonly status: CellStatus;
  readonly detail: string | null;
}

export type LedgerEntry = BindingEntry | SuiteEntry;

export interface MatrixLedger {
  readonly version: 2;
  readonly generatedAt: string;
  readonly scenarios: number;
  readonly proven: number;
  readonly failed: number;
  readonly unrun: number;
  readonly total: number;
  readonly entries: readonly LedgerEntry[];
}
