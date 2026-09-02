import { AnnouncementsService } from "./announcements.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeSelectChain(rows: unknown[]) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(), where, limit: jest.fn(), orderBy: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "orderBy"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  return { builder, where };
}

describe("AnnouncementsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const ANN = { id: 1, orgId: OWNER, title: "Hello", body: "", status: "PUBLISHED", isPinned: false, targetType: "ALL", createdAt: new Date(), updatedAt: new Date() };

  function makeService(rows: unknown[]) {
    const { builder, where } = makeSelectChain(rows);
    const targetWhere = jest.fn();
    const targetsBuilder: Record<string, unknown> = {
      from: jest.fn(), where: targetWhere, limit: jest.fn(),
      then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve([]).then(fn, r); },
      catch(fn: (e: unknown) => unknown) { return Promise.resolve([]).catch(fn); },
      finally(fn: () => void) { return Promise.resolve([]).finally(fn); },
    };
    for (const k of ["from", "where", "limit"]) { (targetsBuilder[k] as jest.Mock).mockReturnValue(targetsBuilder); }
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : targetsBuilder; }),
    } as unknown as Db;
    const svc = new AnnouncementsService(db);
    return { svc, where, targetWhere, targetsBuilder };
  }

  it("list returns empty for a different org (cross-tenant isolation)", async () => {
    const { svc, where } = makeService([]);
    const result = await svc.list(ATTACKER);
    expect(result).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("list returns announcements for the owning org (control)", async () => {
    const { svc, targetWhere, targetsBuilder } = makeService([ANN]);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
    expect(sqlValues(targetWhere.mock.calls[0]?.[0])).toContain(OWNER);
    expect(targetsBuilder.limit).toHaveBeenCalledWith(1000);
  });

  // Regression: markRead took no orgId at all and inserted a read receipt for ANY
  // announcement id in the system. Found by a live cross-tenant HTTP probe --
  // control 201, cross-tenant 201, absent-org 500, i.e. the object really was resolved.
  // announcement_reads.org_id is nullable and the composite FK to (org_id, id) is not
  // enforced when a column is NULL, so nothing in the database caught it either.
  function makeReadService(ownedRows: unknown[]) {
    const { builder, where } = makeSelectChain(ownedRows);
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    const insert = jest.fn().mockReturnValue({ values });
    const db = { select: jest.fn().mockReturnValue(builder), insert } as unknown as Db;
    return { svc: new AnnouncementsService(db), where, insert, values };
  }

  it("markRead refuses an announcement owned by another org, and writes nothing", async () => {
    // The ownership lookup finds no row for the attacker's org.
    const { svc, where, insert } = makeReadService([]);
    await expect(svc.markRead(ATTACKER, ANN.id, "user-attacker")).rejects.toThrow("Announcement not found");
    // 404, never 403: a cross-tenant id must be indistinguishable from a missing one.
    expect(insert).not.toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
    expect(vals).toContain(ANN.id);
  });

  it("markRead accepts the owning org and stamps org_id so the composite FK engages", async () => {
    const { svc, values } = makeReadService([{ id: ANN.id }]);
    await svc.markRead(OWNER, ANN.id, "user-owner");
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0]?.[0]).toEqual({
      orgId: OWNER,
      announcementId: ANN.id,
      userId: "user-owner",
    });
  });
});
