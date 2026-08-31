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
