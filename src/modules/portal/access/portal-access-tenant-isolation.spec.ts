import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { PortalAccessService } from "./portal-access.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";
const audit = { log: jest.fn() };

function makeDb(rows: unknown[]): { db: Db; where: jest.Mock } {
  const where = jest.fn().mockReturnValue({
    limit: jest.fn().mockResolvedValue(rows),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where }),
    }),
    transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    ),
  } as unknown as Db;
  return { db, where };
}

/**
 * A grant read followed by a grant write, with both `where` predicates exposed.
 *
 * `loadGrant` guards `getGrant`, `updateGrant` and `revokeGrant`, and the UPDATE
 * statements carry their own org predicate on top of it — two independent
 * filters, neither of which any test asserted until now. Dropping either one
 * from the source leaves the whole portal suite green, which is why the mocks
 * below hand back the predicates rather than only the results.
 */
function makeGrantDb(
  grantRows: unknown[],
  updatedRows: unknown[] = [],
): { db: Db; selectWhere: jest.Mock; updateWhere: jest.Mock; update: jest.Mock } {
  const selectWhere = jest.fn().mockReturnValue({
    limit: jest.fn().mockResolvedValue(grantRows),
  });
  const updateWhere = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue(updatedRows),
  });
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: updateWhere }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({ where: selectWhere }),
    }),
    update,
  } as unknown as Db;
  return { db, selectWhere, updateWhere, update };
}

const GRANT = {
  projectClientGrantId: "grant-1",
  organizationId: OWNER_ORG,
  portalMembershipId: "pm-1",
  partyContactId: "pc-1",
  projectId: 10,
  status: "ACTIVE",
};

describe("PortalAccessService — cross-tenant isolation (memberships)", () => {
  it("throws NotFoundException when membership belongs to a different org", async () => {
    const { db } = makeDb([]);
    const svc = new PortalAccessService(db, audit as never);

    await expect(
      svc.setMembershipStatus(ATTACKER_ORG, "user-1", "membership-99", { status: "SUSPENDED" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("scopes membership query to the requesting org (isolation)", async () => {
    const { db, where } = makeDb([]);
    const svc = new PortalAccessService(db, audit as never);

    await expect(
      svc.setMembershipStatus(ATTACKER_ORG, "user-1", "membership-99", { status: "SUSPENDED" }),
    ).rejects.toThrow(NotFoundException);

    if (where.mock.calls[0]) {
      const leafValues = sqlValues(where.mock.calls[0][0]);
      expect(leafValues).toContain(ATTACKER_ORG);
    }
  });

  it("proceeds for the owning org (same-tenant control)", async () => {
    const membership = {
      portalMembershipId: "membership-1",
      organizationId: OWNER_ORG,
      status: "ACTIVE",
      audience: "VENDOR",
      partyContactId: "pc-1",
      userId: null,
      deletedAt: null,
      sessionEpoch: 0,
    };
    const updated = { ...membership, status: "SUSPENDED", sessionEpoch: 1 };
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([membership]) }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([updated]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new PortalAccessService(db, audit as never);
    const result = await svc.setMembershipStatus(OWNER_ORG, "user-1", "membership-1", {
      status: "SUSPENDED",
    });
    expect(result).toMatchObject({ status: "SUSPENDED" });
  });
});

/**
 * The other half of portal access, which had no isolation test at all.
 *
 * A grant is the record that says which project a client contact may open, so
 * reading or editing one across a tenant boundary is exactly the BOLA the
 * membership tests above guard against — and `loadGrant` is the only thing
 * standing in the way on three of the six routes. Its org predicate can be
 * deleted from the source without a single portal test turning red, so these
 * assert the predicate itself rather than only the outcome: a `NotFoundException`
 * on an empty result set proves nothing, because an unscoped query that happened
 * to find nothing throws it too.
 *
 * Cross-tenant misses are 404 rather than 403 on purpose — a 403 on another
 * org's id confirms the record exists.
 */
describe("PortalAccessService — cross-tenant isolation (grants)", () => {
  it("scopes the grant read to the requesting org", async () => {
    const { db, selectWhere } = makeGrantDb([]);
    const svc = new PortalAccessService(db, audit as never);

    await expect(svc.getGrant(ATTACKER_ORG, "grant-99")).rejects.toThrow(NotFoundException);

    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("refuses to update a grant owned by another org, and issues no UPDATE", async () => {
    const { db, selectWhere, update } = makeGrantDb([]);
    const svc = new PortalAccessService(db, audit as never);

    await expect(
      svc.updateGrant(ATTACKER_ORG, "user-1", "grant-99", { canViewTasks: true }),
    ).rejects.toThrow(NotFoundException);

    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    expect(update).not.toHaveBeenCalled();
  });

  it("scopes the grant UPDATE itself to the requesting org", async () => {
    const { db, updateWhere } = makeGrantDb([GRANT], [{ ...GRANT, canViewTasks: true }]);
    const svc = new PortalAccessService(db, audit as never);

    await svc.updateGrant(OWNER_ORG, "user-1", "grant-1", { canViewTasks: true });

    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });

  it("refuses to revoke a grant owned by another org, and issues no UPDATE", async () => {
    const { db, selectWhere, update } = makeGrantDb([]);
    const svc = new PortalAccessService(db, audit as never);

    await expect(svc.revokeGrant(ATTACKER_ORG, "user-1", "grant-99")).rejects.toThrow(
      NotFoundException,
    );

    expect(selectWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(selectWhere.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
    expect(update).not.toHaveBeenCalled();
  });

  it("scopes the revoke UPDATE itself to the requesting org", async () => {
    const { db, updateWhere } = makeGrantDb([GRANT], [{ ...GRANT, status: "REVOKED" }]);
    const svc = new PortalAccessService(db, audit as never);

    const result = await svc.revokeGrant(OWNER_ORG, "user-1", "grant-1");

    expect(result).toMatchObject({ status: "REVOKED" });
    expect(updateWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(updateWhere.mock.calls[0]?.[0])).toContain(OWNER_ORG);
  });
});
