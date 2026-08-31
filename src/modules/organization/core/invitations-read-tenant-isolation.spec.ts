import { InvitationsReadService } from "./invitations-read.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

function makeChain(rows: unknown[], count = 0) {
  const where = jest.fn();
  const builder: Record<string, unknown> = {
    from: jest.fn(), where, limit: jest.fn(), offset: jest.fn(), orderBy: jest.fn(), leftJoin: jest.fn(), innerJoin: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve(rows).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve(rows).catch(fn); },
    finally(fn: () => void) { return Promise.resolve(rows).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "offset", "orderBy", "leftJoin", "innerJoin"]) {
    (builder[k] as jest.Mock).mockReturnValue(builder);
  }
  const countBuilder: Record<string, unknown> = {
    from: jest.fn(), where: jest.fn(), limit: jest.fn(), offset: jest.fn(), orderBy: jest.fn(),
    then(fn: (v: unknown) => unknown, r?: (e: unknown) => unknown) { return Promise.resolve([{ count }]).then(fn, r); },
    catch(fn: (e: unknown) => unknown) { return Promise.resolve([{ count }]).catch(fn); },
    finally(fn: () => void) { return Promise.resolve([{ count }]).finally(fn); },
  };
  for (const k of ["from", "where", "limit", "offset", "orderBy"]) {
    (countBuilder[k] as jest.Mock).mockReturnValue(countBuilder);
  }
  return { builder, countBuilder, where };
}

describe("InvitationsReadService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";
  const INV = { id: 1, orgId: OWNER, email: "a@b.com", role: "MEMBER", status: "PENDING", expiresAt: new Date(), acceptedAt: null, createdAt: new Date() };

  it("returns empty list for a different org (cross-tenant isolation)", async () => {
    const { builder, countBuilder, where } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    const result = await svc.listPaginated(ATTACKER);
    expect(result.data).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain(ATTACKER);
  });

  it("returns invitations for the owning org (control)", async () => {
    const { builder, countBuilder } = makeChain([INV], 1);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    const result = await svc.listPaginated(OWNER);
    expect(result.data).toHaveLength(1);
  });
});
