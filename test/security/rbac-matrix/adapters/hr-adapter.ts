import { settle } from "../matrix-runner";
import type { Observation } from "../matrix.types";
import { boundValues, type WorldDb } from "../world-db";

export interface TenantProbe {
  readonly callerOrg: string;
  readonly victimOrg: string;
  readonly ids: readonly unknown[];
}

function slice<T>(list: readonly T[], mark: number): readonly T[] {
  return list.slice(mark);
}

export async function tenantBound(
  world: WorldDb,
  probe: TenantProbe,
  work: () => Promise<unknown>,
  watch: { readonly lookup: string; readonly writes?: { readonly table: string; readonly verb: "insert" | "update" | "delete" }; readonly followUp?: string; readonly sites?: number },
  result: (value: unknown) => Readonly<Record<string, boolean>> = () => ({}),
): Promise<Observation> {
  const readMark = world.reads.length;
  const writeMark = world.writes.length;
  return settle(work, (value) => {
    const reads = slice(world.reads, readMark);
    const lookups = reads.filter((read) => read.table === watch.lookup);
    const writeSites = slice(world.writes, writeMark).filter((write) => write.table === (watch.writes?.table ?? watch.lookup));
    const bound = [...lookups.map((read) => read.where), ...writeSites.map((write) => write.where)].flatMap((where) => boundValues(where));
    const checks: Record<string, boolean> = {
      lookupBindsCallerOrgAndId: bound.includes(probe.callerOrg) && probe.ids.every((id) => bound.includes(id)),
      lookupNeverBindsVictimOrg: probe.callerOrg === probe.victimOrg || !bound.includes(probe.victimOrg),
      ...result(value),
    };
    if (watch.sites !== undefined) checks.exactlyTheExpectedTenantBoundStatements = lookups.length + writeSites.length === watch.sites;
    const writes = watch.writes;
    if (writes !== undefined) {
      const written = writeSites.filter((write) => write.verb === writes.verb);
      checks.writesExactlyOnceOnlyWhenAllowed = value === undefined ? written.length === 0 : written.length === 1;
      if (writes.verb === "insert")
        checks.insertCarriesCallerOrg = written.every(
          (write) => typeof write.values === "object" && write.values !== null && "orgId" in write.values && write.values.orgId === probe.callerOrg,
        );
    }
    const followUp = watch.followUp;
    if (followUp !== undefined) {
      const followed = reads.filter((read) => read.table === followUp).length;
      checks.followUpReadOnlyWhenAllowed = value === undefined ? followed === 0 : followed === 1;
    }
    return checks;
  });
}
