import { makeFakeDb } from "../../../test/fake-select-db";
import type { Db } from "../../../db/drizzle.module";
import { HrEmployeeRecordListsService } from "./hr-employee-record-lists.service";
import { ScopedRead } from "../../access/scoped-read";

const ORG = "org-1";

function hrPerson(overrides: Record<string, unknown>) {
  return {
    id: 1,
    org_id: ORG,
    user_id: null,
    organization_person_id: "p1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    archived_at: null,
    ...overrides,
  };
}

function directoryPerson(overrides: Record<string, unknown>) {
  return {
    organization_id: ORG,
    organization_person_id: "p1",
    first_name: "Ada",
    last_name: "Lovelace",
    work_email: "ada@example.com",
    phone: null,
    gender: null,
    avatar_url: null,
    deleted_at: null,
    archived_at: null,
    ...overrides,
  };
}

describe("HR people list excludes directory-deleted persons", () => {
  it("listPeopleCursor omits an HR record whose directory person is soft-deleted", async () => {
    const db = makeFakeDb({
      hr_people: [hrPerson({ id: 1, organization_person_id: "p1" }), hrPerson({ id: 2, organization_person_id: "p2" })],
      organization_people: [
        directoryPerson({ organization_person_id: "p1" }),
        directoryPerson({ organization_person_id: "p2", first_name: "Gone", deleted_at: new Date() }),
      ],
    });
    const service = new HrEmployeeRecordListsService(db as unknown as Db);

    const page = await service.listPeopleCursor(ScopedRead.of(ORG, "actor", "all"), { limit: 20 });

    expect(page.data.map((row) => row.id)).toEqual([1]);
  });

  it("listPeopleCursor still returns people with a live directory record", async () => {
    const db = makeFakeDb({
      hr_people: [hrPerson({ id: 1, organization_person_id: "p1" })],
      organization_people: [directoryPerson({ organization_person_id: "p1" })],
    });
    const service = new HrEmployeeRecordListsService(db as unknown as Db);

    const page = await service.listPeopleCursor(ScopedRead.of(ORG, "actor", "all"), { limit: 20 });

    expect(page.data.map((row) => row.id)).toEqual([1]);
  });
});
