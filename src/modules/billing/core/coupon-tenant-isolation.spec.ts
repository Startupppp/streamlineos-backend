import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { BillingCoupons } from "./billing-coupons";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const OWNER_ORG = "org-owner";

type Condition = Parameters<PgDialect["sqlToQuery"]>[0];

function render(condition: unknown) {
  return dialect.sqlToQuery(condition as Condition);
}

function findFirstDb(
  captured: { where?: unknown; orderBy?: unknown },
  row: unknown = undefined,
) {
  return {
    query: {
      coupons: {
        findFirst: jest.fn(async (args: { where?: unknown; orderBy?: unknown }) => {
          captured.where = args.where;
          captured.orderBy = args.orderBy;
          return row;
        }),
        findMany: jest.fn(async () => []),
      },
      couponRedemptions: { findFirst: jest.fn(async () => undefined) },
    },
  } as unknown as Db;
}

describe("BillingCoupons — tenant isolation", () => {
  it("evaluate only matches a coupon owned by the caller's org or a platform-wide coupon", async () => {
    const captured: { where?: unknown } = {};
    const coupons = new BillingCoupons(findFirstDb(captured));

    await coupons.evaluate(7, OWNER_ORG, "STARTER", 100_000);

    const query = render(captured.where);
    expect(query.sql).toContain('"coupons"."org_id"');
    expect(query.sql).toContain("is null");
    expect(query.params).toContain(OWNER_ORG);
  });

  it("validate scopes the code lookup to the caller's org", async () => {
    const captured: { where?: unknown } = {};
    const coupons = new BillingCoupons(findFirstDb(captured));

    const result = await coupons.validate("SAVE10", OWNER_ORG, "STARTER");

    expect(result.valid).toBe(false);
    const query = render(captured.where);
    expect(query.sql).toContain('"coupons"."org_id"');
    expect(query.params).toContain(OWNER_ORG);
  });

  /**
   * `coupons.code` is unique per tenant and unique among platform coupons, but not
   * across the two — migration 0993 replaced one global unique with two partial ones.
   * So an organisation can own a code that also exists platform-wide, and an unordered
   * `findFirst` then resolves it arbitrarily: the same request can price against the
   * tenant's coupon on one connection and the platform's on the next.
   */
  it("resolves a colliding code to the org's own coupon, not the platform one", async () => {
    const captured: { where?: unknown; orderBy?: unknown } = {};
    const coupons = new BillingCoupons(findFirstDb(captured));

    await coupons.validate("SAVE10", OWNER_ORG, "STARTER");

    const order = captured.orderBy as unknown[];
    expect(Array.isArray(order)).toBe(true);
    expect(order.length).toBeGreaterThanOrEqual(1);
    // The ownership key must come first. Ordering by id first would hand the row to
    // whichever coupon was created earlier, which is exactly the arbitrary choice.
    const primary = render(order[0]).sql.toLowerCase();
    expect(primary).toContain('"coupons"."org_id"');
    expect(primary).toContain("is null");
    expect(primary).not.toContain("desc");
  });

  it("evaluate needs no ordering because it keys on the primary key", async () => {
    const captured: { where?: unknown; orderBy?: unknown } = {};
    const coupons = new BillingCoupons(findFirstDb(captured));

    await coupons.evaluate(7, OWNER_ORG, "STARTER", 100_000);

    const query = render(captured.where);
    expect(query.sql).toContain('"coupons"."id"');
    expect(query.params).toContain(7);
  });

  it("listRedeemable returns only redeemable coupons and only the caller's own redemptions", async () => {
    const captured: { where?: unknown; nested?: unknown } = {};
    const db = {
      query: {
        coupons: {
          findMany: jest.fn(async (args: { where?: unknown; with?: { redemptions?: { where?: unknown } } }) => {
            captured.where = args.where;
            captured.nested = args.with?.redemptions?.where;
            return [];
          }),
        },
      },
    } as unknown as Db;

    await new BillingCoupons(db).listRedeemable(OWNER_ORG);

    const scope = render(captured.where);
    expect(scope.sql).toContain('"coupons"."org_id"');
    expect(scope.params).toContain(OWNER_ORG);

    const redemptions = render(captured.nested);
    expect(redemptions.sql).toContain('"org_id"');
    expect(redemptions.params).toContain(OWNER_ORG);
  });

  it("create (platform) always writes org_id NULL — never a tenant row", async () => {
    const values: Array<Record<string, unknown>> = [];
    const db = {
      insert: jest.fn(() => ({
        values: (v: Record<string, unknown>) => {
          values.push(v);
          return { returning: async () => [{ id: 1, ...v }] };
        },
      })),
    } as unknown as Db;

    await new BillingCoupons(db).create({
      code: "SAVE10",
      type: "PERCENTAGE",
      value: 10,
    });

    expect(values[0]?.orgId).toBeNull();
  });

  it("update (platform) scopes WHERE to org_id IS NULL so a tenant row is never touched", async () => {
    let where: unknown;
    const db = {
      update: jest.fn(() => ({
        set: () => ({
          where: (condition: unknown) => {
            where = condition;
            return { returning: async () => [] };
          },
        }),
      })),
    } as unknown as Db;

    await expect(
      new BillingCoupons(db).update(7, { isActive: false }),
    ).rejects.toThrow(NotFoundException);

    const query = render(where);
    expect(query.sql).toContain('"coupons"."org_id"');
    expect(query.sql).toContain("is null");
  });

  it("remove (platform) scopes WHERE to org_id IS NULL so a tenant row is never touched", async () => {
    let where: unknown;
    const db = {
      update: jest.fn(() => ({
        set: () => ({
          where: (condition: unknown) => {
            where = condition;
            return { returning: async () => [] };
          },
        }),
      })),
    } as unknown as Db;

    await expect(new BillingCoupons(db).remove(7)).rejects.toThrow(
      NotFoundException,
    );

    const query = render(where);
    expect(query.sql).toContain('"coupons"."org_id"');
    expect(query.sql).toContain("is null");
  });

  it("remove (platform) succeeds for an existing platform promotion", async () => {
    const db = {
      update: jest.fn(() => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: 7 }] }) }),
      })),
    } as unknown as Db;

    await expect(new BillingCoupons(db).remove(7)).resolves.toEqual({
      success: true,
    });
  });
});
