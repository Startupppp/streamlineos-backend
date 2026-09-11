import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { BillingCoupons } from "./billing-coupons";
import type { CreateCouponInput } from "./dto/billing.schemas";

const INPUT: CreateCouponInput = { code: "save10", type: "PERCENTAGE", value: 10 };

function dbWhoseInsertRejects(err: unknown): Db {
  const returning = jest.fn().mockRejectedValue(err);
  return {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) }),
  } as unknown as Db;
}

describe("BillingCoupons.create — a duplicate code", () => {
  it("is a 409 naming the code, not a 500, when coupons.code refuses it", async () => {
    const coupons = new BillingCoupons(dbWhoseInsertRejects(drizzleUniqueViolation("coupons_code_unique")));

    const attempt = coupons.create(INPUT);

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow("A coupon with the code SAVE10 already exists");
  });

  it("a different database error propagates untouched", async () => {
    const err = drizzlePostgresError("23503", "some_fk");
    const coupons = new BillingCoupons(dbWhoseInsertRejects(err));

    await expect(coupons.create(INPUT)).rejects.toBe(err);
  });
});
