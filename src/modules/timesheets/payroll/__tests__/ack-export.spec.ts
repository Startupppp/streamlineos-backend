import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import { PayrollExportsReadService } from "../payroll-exports-read.service";

const ORG = "org-ack";
const ACTOR = "user-ack";

/**
 * `ackExport` is called again for the same export as the payroll side works
 * through it, so it cannot be "write once". What it must not do is record the
 * status the export already has (a retry, emitting a second handoff event for
 * one fact), withdraw a settled answer back to RECEIVED, or let two operators
 * both win against the same stale reading. The double below queues the first
 * read's row and the UPDATE's outcome, and records every write.
 */
function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value !== "object") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    orgId: ORG,
    exportType: "PAYROLL",
    status: "COMPLETED",
    dateRangeStart: "2026-06-01",
    dateRangeEnd: "2026-06-07",
    format: "CSV",
    entryCount: 3,
    totalHours: "24.00",
    note: null,
    ackStatus: "ACCEPTED",
    ackNote: null,
    ackAt: new Date("2026-06-10T10:00:00Z"),
    ackByMembershipId: 4,
    createdByMembershipId: 4,
    eventSeq: 2,
    createdAt: new Date("2026-06-08T10:00:00Z"),
    ...overrides,
  };
}

function harness(opts: {
  existing: { ackStatus: string | null } | null;
  updateReturns: Record<string, unknown>[];
}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: { set: Record<string, unknown>; where: unknown }[] = [];
  const selectQueue: unknown[][] = [
    opts.existing ? [{ id: 7, ackStatus: opts.existing.ackStatus, creatorName: "Priya" }] : [],
    [{ id: 4 }],
  ];
  const selectChain = () => {
    const rows = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "leftJoin", "where", "orderBy"]) chain[step] = () => chain;
    chain["limit"] = () => Promise.resolve(rows);
    return chain;
  };
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: unknown) => ({
          returning: () => {
            updates.push({ set: values, where: predicate });
            return Promise.resolve(opts.updateReturns);
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return Promise.resolve();
      },
    }),
  };
  const db = {
    select: selectChain,
    transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as Db;
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
  const audit = { log: jest.fn() };
  const service = new PayrollExportsReadService(db, cache as never, audit as never);
  return { service, inserted, updates, cache, audit };
}

describe("PayrollExportsReadService.ackExport", () => {
  it("404s an export the organisation does not have", async () => {
    const { service, updates } = harness({ existing: null, updateReturns: [] });

    await expect(service.ackExport(ORG, ACTOR, 7, { status: "ACCEPTED" })).rejects.toBeInstanceOf(NotFoundException);
    expect(updates).toHaveLength(0);
  });

  it("refuses to record the status the export already carries, and writes nothing", async () => {
    const { service, updates, inserted, audit } = harness({
      existing: { ackStatus: "ACCEPTED" },
      updateReturns: [exportRow()],
    });

    await expect(service.ackExport(ORG, ACTOR, 7, { status: "ACCEPTED" })).rejects.toBeInstanceOf(ConflictException);
    expect(updates).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses to take a settled export back to RECEIVED", async () => {
    const { service, updates } = harness({
      existing: { ackStatus: "REJECTED" },
      updateReturns: [exportRow()],
    });

    await expect(service.ackExport(ORG, ACTOR, 7, { status: "RECEIVED" })).rejects.toThrow(/cannot go back to RECEIVED/);
    expect(updates).toHaveLength(0);
  });

  it("records a legitimate move, numbering the event from the counter the UPDATE claimed", async () => {
    const { service, updates, inserted, cache, audit } = harness({
      existing: { ackStatus: "RECEIVED" },
      updateReturns: [exportRow({ ackStatus: "ACCEPTED", eventSeq: 3 })],
    });

    const result = await service.ackExport(ORG, ACTOR, 7, { status: "ACCEPTED", note: "run 12" });

    expect(result.export.ackStatus).toBe("ACCEPTED");
    expect(updates).toHaveLength(1);
    const [update] = updates;
    expect(update.set["ackStatus"]).toBe("ACCEPTED");
    expect(update.set["ackByMembershipId"]).toBe(4);
    /* The counter moves in the same statement as the status. */
    expect(sqlValues(update.set["eventSeq"])).toContain(" + 1");
    /* The UPDATE is conditional on the status the rule was checked against. */
    expect(sqlValues(update.where)).toContain("RECEIVED");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]["aggregateVersion"]).toBe(3);
    expect(inserted[0]["aggregateId"]).toBe("7");
    expect(cache.invalidateNamespace).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("predicates the first acknowledgement on the status still being unset", async () => {
    const { service, updates } = harness({
      existing: { ackStatus: null },
      updateReturns: [exportRow({ ackStatus: "RECEIVED", eventSeq: 2 })],
    });

    await service.ackExport(ORG, ACTOR, 7, { status: "RECEIVED" });

    const predicate = JSON.stringify(sqlValues(updates[0].where));
    expect(predicate).toMatch(/is null/i);
  });

  it("tells a lost race apart from success: no event, no audit, a 409", async () => {
    const { service, inserted, audit, cache } = harness({
      existing: { ackStatus: "RECEIVED" },
      updateReturns: [],
    });

    await expect(service.ackExport(ORG, ACTOR, 7, { status: "ACCEPTED" })).rejects.toBeInstanceOf(ConflictException);
    expect(inserted).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
    expect(cache.invalidateNamespace).not.toHaveBeenCalled();
  });
});
