jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(
    (_db: unknown, work: (tx: unknown) => Promise<unknown>) => work(_db),
  ),
}));

import { ConflictException } from "@nestjs/common";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { Db } from "../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import { PrincipalGroupsService } from "./principal-groups.service";

/**
 * A duplicate group name, as the database reports it.
 *
 * uniq_principal_groups_org_name refuses a second group with the same name in
 * one org. create and rename both translate that into a 409; drizzle hands
 * them a DrizzleQueryError with the SQLSTATE on `.cause`, so the read has to
 * look through the wrapper.
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

function makeService(writeError: Error): PrincipalGroupsService {
  const db = {
    query: {
      principalGroups: {
        findFirst: jest.fn().mockResolvedValue({ id: "grp-1", kind: "CUSTOM" }),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockRejectedValue(writeError) }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockRejectedValue(writeError) }),
    }),
  } as unknown as Db;
  return new PrincipalGroupsService(db, {} as never, {} as never);
}

describe("PrincipalGroupsService — duplicate names", () => {
  it("create answers 409 when the name is already taken", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_principal_groups_org_name"));
    await expect(service.create(actor, { name: "Finance" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("rename answers 409 when the new name is already taken", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_principal_groups_org_name"));
    await expect(service.rename(actor, "grp-1", { name: "Finance" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("create rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.create(actor, { name: "Finance" })).rejects.toBe(fkViolation);
  });

  it("rename rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.rename(actor, "grp-1", { name: "Finance" })).rejects.toBe(fkViolation);
  });
});
