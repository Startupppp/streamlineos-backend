import { ConflictException } from "@nestjs/common";
import { DrizzleQueryError } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { TaxCodesService } from "./tax-codes.service";

describe("TaxCodesService — duplicate tax codes", () => {
  const ORG = "org-1";
  const input = {
    name: "GST 18%",
    code: "GST18",
    rate: "18.00",
    taxType: "GST" as const,
    isReverseCharge: false,
    collectedAccountId: 11,
    paidAccountId: 12,
    isActive: true,
  };
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;
  const audit = { log: jest.fn() } as never;
  const posting = { resolveSystemAccount: jest.fn() } as never;

  function insertRejecting(err: Error): Db {
    return {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(err) }),
      }),
    } as unknown as Db;
  }

  function updateRejecting(err: Error): Db {
    return {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 5, code: "GST5" }]) }),
        }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(err) }),
        }),
      }),
    } as unknown as Db;
  }

  it("create answers 409 when the code is already taken in the org", async () => {
    const db = insertRejecting(drizzleUniqueViolation("uniq_acc_tax_codes_org_code"));
    const svc = new TaxCodesService(db, cache, audit, posting);

    await expect(svc.create(ORG, "user-1", input)).rejects.toBeInstanceOf(ConflictException);
  });

  it("update answers 409 when the new code is already taken in the org", async () => {
    const db = updateRejecting(drizzleUniqueViolation("uniq_acc_tax_codes_org_code"));
    const svc = new TaxCodesService(db, cache, audit, posting);

    await expect(svc.update(ORG, 5, "user-1", { code: "GST18" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not mistake another failure for a duplicate because a bound value reads 23505", async () => {
    // The old check searched the wrapper's message, which is the SQL text plus its
    // params, so a tax code literally named "23505" turned any failure into a 409.
    const fkViolation = new DrizzleQueryError(
      "insert into acc_tax_codes ...",
      ["23505"],
      Object.assign(new Error("insert or update violates foreign key constraint"), { code: "23503" }),
    );
    const svc = new TaxCodesService(insertRejecting(fkViolation), cache, audit, posting);

    await expect(svc.create(ORG, "user-1", { ...input, code: "23505" })).rejects.toBe(fkViolation);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_acc_tax_codes_collected_account");
    const svc = new TaxCodesService(insertRejecting(fkViolation), cache, audit, posting);

    await expect(svc.create(ORG, "user-1", input)).rejects.toBe(fkViolation);
  });
});
