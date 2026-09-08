import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PublicReferrersService } from "./public-referrers.service";

describe("PublicReferrersService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(orgRow: unknown): Db {
    return {
      query: {
        organizations: { findFirst: jest.fn().mockResolvedValue(orgRow) },
        externalReferrers: { findFirst: jest.fn().mockResolvedValue(null) },
        jobPostings: { findMany: jest.fn().mockResolvedValue([]) },
        externalReferrals: { findMany: jest.fn().mockResolvedValue([]) },
      },
      execute: jest.fn().mockResolvedValue([]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        query: {
          externalReferrers: { findFirst: jest.fn().mockResolvedValue(null) },
        },
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1, referralToken: "tok" }]) }) }),
        execute: jest.fn().mockResolvedValue([]),
      })),
    } as unknown as Db;
  }

  it("throws NotFoundException for a non-existent org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new PublicReferrersService(db, {} as never);
    await expect(
      svc.registerExternalReferrer({ orgId: ATTACKER, email: "attacker@evil.com", name: "Attacker" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("registers referrer for a valid org (control — correct org)", async () => {
    const db = makeDb({ id: OWNER, name: "Owner Corp" });
    const svc = new PublicReferrersService(db, {} as never);
    const result = await svc.registerExternalReferrer({ orgId: OWNER, email: "ref@owner.com", name: "Referrer" });
    expect(result).toBeDefined();
  });
});
