import { ConflictException } from "@nestjs/common";
import type { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { CacheService } from "../../../common/cache/cache.service";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { DimensionsService } from "./dimensions.service";

/**
 * A duplicate dimension key or value code, as the database reports it.
 *
 * uniq_accounting_dimensions_org_key refuses a second dimension with the same
 * key in one org, and uniq_accounting_dim_values_org_dim_code a second value
 * with the same code in one dimension. Drizzle hands the service a
 * DrizzleQueryError with the SQLSTATE on `.cause`, so the conflict read has to
 * look through the wrapper to answer 409.
 */

const actor: CurrentUserContext = {
  orgId: "org-1",
  userId: "user-1",
  role: "ADMIN",
  isOrgOwner: false,
  sessionId: "sess-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

function makeService(insertError: Error): DimensionsService {
  const db = {
    // createValue first confirms the dimension belongs to the org.
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 7 }]) }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(insertError) }),
    }),
  } as unknown as Db;
  const cache = { cached: jest.fn(), invalidate: jest.fn() } as unknown as CacheService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  return new DimensionsService(db, cache, audit);
}

const dimensionInput = { name: "Region", key: "region", requiredForAccountTypes: [] };
const valueInput = { name: "North", code: "N" };

describe("DimensionsService — duplicate keys and codes", () => {
  it("createDimension answers 409 when the key is already taken", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_accounting_dimensions_org_key"));
    await expect(service.createDimension(actor, dimensionInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("createValue answers 409 when the code is already taken in the dimension", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_accounting_dim_values_org_dim_code"));
    await expect(service.createValue(actor, 7, valueInput)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("createDimension rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.createDimension(actor, dimensionInput)).rejects.toBe(fkViolation);
  });

  it("createValue rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.createValue(actor, 7, valueInput)).rejects.toBe(fkViolation);
  });
});
