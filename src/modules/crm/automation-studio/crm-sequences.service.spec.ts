import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../../test/postgres-error-fixture";
import { CrmSequencesService } from "./crm-sequences.service";

/**
 * A duplicate sequence name, as the database reports it.
 *
 * uniq_crm_sequences_org_name refuses a second sequence with the same name in
 * one org. Drizzle hands the service a DrizzleQueryError with the SQLSTATE on
 * `.cause`, so the conflict read has to look through the wrapper to answer 409.
 */

const ORG = "org-1";

function makeService(writeError: Error): CrmSequencesService {
  const returning = jest.fn().mockRejectedValue(writeError);
  const db = {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    }),
  } as unknown as Db;
  return new CrmSequencesService(db);
}

describe("CrmSequencesService — duplicate names", () => {
  it("create answers 409 when the name is already taken", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_crm_sequences_org_name"));
    await expect(
      service.create(ORG, { name: "Welcome", entityType: "lead", isActive: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("update answers 409 when the new name is already taken", async () => {
    const service = makeService(drizzleUniqueViolation("uniq_crm_sequences_org_name"));
    await expect(service.update(ORG, "seq-1", { name: "Welcome" })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("create rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(
      service.create(ORG, { name: "Welcome", entityType: "lead", isActive: true }),
    ).rejects.toBe(fkViolation);
  });

  it("update rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "some_fk");
    const service = makeService(fkViolation);
    await expect(service.update(ORG, "seq-1", { name: "Welcome" })).rejects.toBe(fkViolation);
  });
});
