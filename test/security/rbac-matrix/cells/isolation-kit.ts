import type { AdapterBinding, Observation, Scenario } from "../matrix.types";
import { matrixRows } from "../fixtures";
import { outcomeOfError } from "../matrix-runner";
import { ORG_A, ORG_B, standingRows } from "../standings";
import { boundValues, mergeRows, worldDb, type WorldDb, type WorldRows } from "../world-db";

export interface PairSide {
  readonly because: string;
  readonly bindings: readonly AdapterBinding[];
}

export const TENANT_ONLY = { actor: "tenant-only", state: "normal" } satisfies Pick<Scenario, "actor" | "state">;

export function pair(
  base: Omit<Scenario, "id" | "tenant" | "expected" | "because" | "pairedWith" | "bindings">,
  id: string,
  allow: PairSide,
  deny: PairSide,
): Scenario[] {
  return [
    { ...base, id: `${id}-same-tenant`, tenant: "same", expected: "allow", because: allow.because, bindings: allow.bindings },
    { ...base, id: `${id}-cross-tenant`, tenant: "other", expected: "404", because: deny.because, pairedWith: `${id}-same-tenant`, bindings: deny.bindings },
  ];
}

export function victimOf(callerOrg: string): string {
  return callerOrg === ORG_A ? ORG_B : ORG_A;
}

export function freshWorld(...parts: readonly WorldRows[]): WorldDb {
  return worldDb(mergeRows(matrixRows(), ...parts), { mutable: true });
}

export function standingWorld(...parts: readonly WorldRows[]): WorldDb {
  return worldDb(mergeRows(standingRows(ORG_A), standingRows(ORG_B), ...parts), { mutable: true });
}

export function boundBy(world: WorldDb, mark: { readonly reads: number; readonly writes: number }, table: string): unknown[] {
  return [
    ...world.reads.slice(mark.reads).filter((read) => read.table === table).map((read) => read.where),
    ...world.writes.slice(mark.writes).filter((write) => write.table === table).map((write) => write.where),
  ].flatMap((where) => boundValues(where));
}

export function markOf(world: WorldDb): { readonly reads: number; readonly writes: number } {
  return { reads: world.reads.length, writes: world.writes.length };
}

export async function reached(
  work: () => Promise<unknown>,
  didReach: () => boolean,
  checks: () => Readonly<Record<string, boolean>> = () => ({}),
): Promise<Observation> {
  try {
    await work();
  } catch (error: unknown) {
    return { outcome: outcomeOfError(error), checks: checks() };
  }
  return { outcome: didReach() ? "allow" : "404", checks: checks() };
}
