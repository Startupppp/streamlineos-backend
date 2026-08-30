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
    const targetsBuilder: Record<string, unknown> = {
      from: jest.fn(), where: jest.fn(), limit: jest.fn(),
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
    return { svc, where };
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
    const { svc } = makeService([ANN]);
    const result = await svc.list(OWNER);
    expect(result).toHaveLength(1);
  });
});
