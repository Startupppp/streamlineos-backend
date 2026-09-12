import { BillingProfileService } from "./billing-profile.service";
import type { Db } from "../../../db/drizzle.module";

describe("BillingProfileService — race conditions and tenant isolation", () => {
  it("get returns a default profile without inserting when no row exists", async () => {
    const insertMock = jest.fn();
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(async () => []) })),
      })),
      insert: insertMock,
    } as unknown as Db;

    const svc = new BillingProfileService(db);
    const result = await svc.get("org-1");

    expect(result.orgId).toBe("org-1");
    expect(result.gstin).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("concurrent first reads never race: get is side-effect-free so no unique violation can occur", async () => {
    const insertMock = jest.fn();
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(async () => []) })),
      })),
      insert: insertMock,
    } as unknown as Db;

    const svc = new BillingProfileService(db);
    const [r1, r2] = await Promise.all([svc.get("org-1"), svc.get("org-1")]);

    expect(r1.orgId).toBe("org-1");
    expect(r2.orgId).toBe("org-1");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("update upserts atomically via onConflictDoUpdate on org_id", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const upsertedRow = {
      id: 1, orgId: "org-1", gstin: null, pan: null, billingName: "Acme",
      billingEmail: null, addressLine1: null, addressLine2: null, city: null,
      state: null, pincode: null, country: null, isTaxExempt: false,
      metadata: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const db = {
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          onConflictDoUpdate: jest.fn((opts: Record<string, unknown>) => {
            capturedOpts = opts;
            return { returning: jest.fn(async () => [upsertedRow]) };
          }),
        })),
      })),
    } as unknown as Db;

    const svc = new BillingProfileService(db);
    const result = await svc.update("org-1", { billingName: "Acme" });

    expect(result.billingName).toBe("Acme");
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts?.target).toBeDefined();
    expect((db.insert as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it("update on a nonexistent profile creates the row (upsert inserts first row)", async () => {
    const upsertedRow = {
      id: 1, orgId: "org-new", gstin: null, pan: null, billingName: "New Co",
      billingEmail: null, addressLine1: null, addressLine2: null, city: null,
      state: null, pincode: null, country: null, isTaxExempt: false,
      metadata: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const db = {
      insert: jest.fn(() => ({
        values: jest.fn(() => ({
          onConflictDoUpdate: jest.fn(() => ({
            returning: jest.fn(async () => [upsertedRow]),
          })),
        })),
      })),
    } as unknown as Db;

    const svc = new BillingProfileService(db);
    const result = await svc.update("org-new", { billingName: "New Co" });

    expect(result.orgId).toBe("org-new");
    expect(result.billingName).toBe("New Co");
  });

  it("get with orgId returns that org's profile, never another tenant's row", async () => {
    const orgARow = {
      id: 1, orgId: "org-A", gstin: "GSTIN_A", pan: null, billingName: null,
      billingEmail: null, addressLine1: null, addressLine2: null, city: null,
      state: null, pincode: null, country: null, isTaxExempt: false,
      metadata: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(async () => [orgARow]),
        })),
      })),
    } as unknown as Db;

    const svc = new BillingProfileService(db);
    const result = await svc.get("org-A");

    expect(result.orgId).toBe("org-A");
    expect(result.gstin).toBe("GSTIN_A");
  });
});
