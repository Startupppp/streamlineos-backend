import { ConflictException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import type { CreateSubjectTypeInput } from "./dto/subject.schemas";
import { SubjectTypeService } from "./subject-type.service";

const ORG_ID = "org-1";
const USER_ID = "user-1";

const INPUT: CreateSubjectTypeInput = {
  key: "property",
  singular: "Property",
  plural: "Properties",
  titleField: "address",
  fields: [{ name: "address", label: "Address", kind: "text" }],
};

describe("SubjectTypeService.createType", () => {
  function createService(insertError: Error) {
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(insertError),
        }),
      }),
    };
    const audit = { log: jest.fn() };
    return { service: new SubjectTypeService(db as never, audit as never), audit };
  }

  it("answers 409 when the tenant already has a type with this key", async () => {
    // uniq_subject_types_org_key, as drizzle surfaces it.
    const { service, audit } = createService(drizzleUniqueViolation("uniq_subject_types_org_key"));
    await expect(service.createType(ORG_ID, USER_ID, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_subject_types_organization");
    const { service } = createService(fkViolation);
    await expect(service.createType(ORG_ID, USER_ID, INPUT)).rejects.toBe(fkViolation);
  });
});
