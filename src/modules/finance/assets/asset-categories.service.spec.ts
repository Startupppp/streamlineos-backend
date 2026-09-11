import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { AssetCategoriesService } from "./asset-categories.service";

describe("AssetCategoriesService — duplicate category names", () => {
  const ORG = "org-1";
  const accounts = [
    { id: 1, accountType: "ASSET" },
    { id: 2, accountType: "EXPENSE" },
    { id: 3, accountType: "ASSET" },
  ];
  const existing = {
    id: 9,
    orgId: ORG,
    name: "Vehicles",
    assetAccountId: 1,
    depreciationExpenseAccountId: 2,
    accumulatedDepreciationAccountId: 3,
    defaultMethod: "STRAIGHT_LINE",
  };
  const input = {
    name: "Vehicles",
    assetAccountId: 1,
    depreciationExpenseAccountId: 2,
    accumulatedDepreciationAccountId: 3,
    defaultMethod: "STRAIGHT_LINE" as const,
  };
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) } as never;

  function makeDb(writeError: Error): Db {
    // One select chain serves both reads: awaited straight off `where` it is the
    // account list validateAccountLinks checks; through `.limit(1)` it is findOrThrow.
    const where = jest
      .fn()
      .mockImplementation(() =>
        Object.assign(Promise.resolve(accounts), { limit: jest.fn().mockResolvedValue([existing]) }),
      );
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(writeError) }),
      }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(writeError) }),
        }),
      }),
    } as unknown as Db;
  }

  it("create answers 409 when the name is already taken in the org", async () => {
    const db = makeDb(drizzleUniqueViolation("uniq_acc_asset_categories_org_name"));
    const svc = new AssetCategoriesService(db, cache);

    await expect(svc.create(ORG, input)).rejects.toBeInstanceOf(ConflictException);
  });

  it("update answers 409 when the new name is already taken in the org", async () => {
    const db = makeDb(drizzleUniqueViolation("uniq_acc_asset_categories_org_name"));
    const svc = new AssetCategoriesService(db, cache);

    await expect(svc.update(ORG, 9, { name: "Vehicles" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_acc_asset_categories_asset_account");
    const svc = new AssetCategoriesService(makeDb(fkViolation), cache);

    await expect(svc.create(ORG, input)).rejects.toBe(fkViolation);
  });
});
