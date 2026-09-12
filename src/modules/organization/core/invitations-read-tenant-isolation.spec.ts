import { BadRequestException } from "@nestjs/common";
import { encodeCursor } from "../../../common/pagination/cursor";
import { InvitationsReadService } from "./invitations-read.service";
import type { Db } from "../../../db/drizzle.module";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (value instanceof Date) return [value];
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
  const INV = { id: "inv-1", orgId: OWNER, email: "a@b.com", role: "MEMBER", status: "PENDING", expiresAt: new Date(), acceptedAt: null, createdAt: new Date(), revokedAt: null, declinedAt: null, deliveryFailed: false };

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

describe("InvitationsReadService — declined filter", () => {
  const ORG = "org-declined-test";
  const DECLINED_INV = {
    id: "inv-declined",
    orgId: ORG,
    email: "d@b.com",
    role: "MEMBER",
    status: "DECLINED",
    expiresAt: new Date(),
    acceptedAt: null,
    createdAt: new Date(),
    revokedAt: null,
    declinedAt: new Date(),
    deliveryFailed: false,
  };

  it("includes DECLINED status value in WHERE conditions when status=declined", async () => {
    const { builder, countBuilder, where } = makeChain([DECLINED_INV], 1);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    await svc.listPaginated(ORG, { status: "declined" });
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain("DECLINED");
  });

  it("does not include DECLINED status in default (no status) results", async () => {
    const { builder, countBuilder, where } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    await svc.listPaginated(ORG);
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).not.toContain("DECLINED");
    expect(vals).toContain("PENDING");
  });
});

describe("InvitationsReadService — cursor cross-scope rejection", () => {
  const OWNER_ORG = "org-owner-cursor";
  const OTHER_ORG = "org-other-cursor";

  function makeCursorForOrg(orgId: string): string {
    const now = new Date();
    const scopeId = JSON.stringify([orgId, false, null, null, "inv-abc"]);
    return encodeCursor({ sortValue: now.toISOString(), id: scopeId });
  }

  it("throws BadRequestException when cursor was minted for a different org", async () => {
    const { builder, countBuilder } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    const foreignCursor = makeCursorForOrg(OTHER_ORG);
    await expect(
      svc.listPaginated(OWNER_ORG, { cursor: foreignCursor }),
    ).rejects.toThrow(BadRequestException);
  });

  it("throws BadRequestException when cursor scope filter does not match current params", async () => {
    const { builder, countBuilder } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    const cursorMintedWithStatusPending = encodeCursor({
      sortValue: new Date().toISOString(),
      id: JSON.stringify([OWNER_ORG, false, "pending", null, "inv-abc"]),
    });
    await expect(
      svc.listPaginated(OWNER_ORG, { cursor: cursorMintedWithStatusPending, status: "accepted" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("accepts a valid cursor matching the current scope", async () => {
    const { builder, countBuilder } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    const validCursor = makeCursorForOrg(OWNER_ORG);
    const result = await svc.listPaginated(OWNER_ORG, { cursor: validCursor });
    expect(result.data).toHaveLength(0);
  });
});

describe("InvitationsReadService — expiry boundary determinism", () => {
  const ORG = "org-expiry-test";

  it("includes expiresAt boundary value in WHERE for pending filter", async () => {
    const { builder, countBuilder, where } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    await svc.listPaginated(ORG, { status: "pending" });
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain("PENDING");
    const hasBoundaryDate = vals.some((v) => v instanceof Date);
    expect(hasBoundaryDate).toBe(true);
  });

  it("includes expiresAt boundary value in WHERE for expired filter via expiredByTimePredicate", async () => {
    const { builder, countBuilder, where } = makeChain([], 0);
    let call = 0;
    const db = {
      select: jest.fn().mockImplementation(() => { call++; return call === 1 ? builder : countBuilder; }),
    } as unknown as Db;
    const svc = new InvitationsReadService(db);
    await svc.listPaginated(ORG, { status: "expired" });
    expect(where).toHaveBeenCalled();
    const vals = sqlValues(where.mock.calls[0]?.[0]);
    expect(vals).toContain("PENDING");
    const hasBoundaryDate = vals.some((v) => v instanceof Date);
    expect(hasBoundaryDate).toBe(true);
  });
});
