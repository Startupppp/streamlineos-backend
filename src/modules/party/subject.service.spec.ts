import { ConflictException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import type { CreateSubjectInput } from "./dto/subject.schemas";
import { SubjectService } from "./subject.service";

const ORG_ID = "org-1";
const USER_ID = "user-1";

const SUBJECT_TYPE = {
  subjectTypeId: "type-1",
  organizationId: ORG_ID,
  key: "property",
  singular: "Property",
  plural: "Properties",
  titleField: "address",
  fields: [{ name: "address", label: "Address", kind: "text" }],
  deletedAt: null,
};

const INPUT: CreateSubjectInput = {
  subjectTypeId: "type-1",
  reference: "LST-001",
  values: { address: "1 Main Street" },
};

describe("SubjectService.createSubject", () => {
  function createService(insertError: Error) {
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(insertError),
        }),
      }),
    };
    const audit = { log: jest.fn() };
    const types = { requireType: jest.fn().mockResolvedValue(SUBJECT_TYPE) };
    return {
      service: new SubjectService(db as never, audit as never, types as never),
      audit,
    };
  }

  it("answers 409 when the reference is already taken for this type", async () => {
    // uniq_subjects_org_type_reference, as drizzle surfaces it.
    const { service, audit } = createService(
      drizzleUniqueViolation("uniq_subjects_org_type_reference"),
    );
    await expect(service.createSubject(ORG_ID, USER_ID, INPUT)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_subjects_org_type");
    const { service } = createService(fkViolation);
    await expect(service.createSubject(ORG_ID, USER_ID, INPUT)).rejects.toBe(fkViolation);
  });
});
