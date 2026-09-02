import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import type { Db } from "../../db/drizzle.module";
import { organizationPeople } from "../../db/schema/directory";
import { DirectoryService } from "./directory.service";
import type { AuditService } from "../../common/audit/audit.service";
import type { DirectoryIdentityService } from "./directory-identity.service";
import type { WorkerEngagementsService } from "./worker-engagements.service";
import {
  DIRECTORY_PERSON_COLUMNS,
  DIRECTORY_PERSON_RESTRICTED_COLUMNS,
  toDirectoryPerson,
} from "./directory-person-projection";

const RESTRICTED_SQL_COLUMNS = [
  "date_of_birth",
  "gender",
  "nationality",
  "address",
  "emergency_contact",
];

function renderedSelectList(): string {
  const query = new QueryBuilder()
    .select(DIRECTORY_PERSON_COLUMNS)
    .from(organizationPeople);
  return new PgDialect().sqlToQuery(query.getSQL()).sql;
}

function fullPersonRow(): typeof organizationPeople.$inferSelect {
  return {
    organizationPersonId: "person-1",
    organizationId: "org-1",
    userId: "user-1",
    organizationMembershipId: 7,
    firstName: "Jane",
    lastName: "Doe",
    displayName: "Jane Doe",
    preferredName: null,
    workEmail: "jane@example.com",
    personalEmail: "jane@personal.example.com",
    phone: "+1000000000",
    whatsappNumber: null,
    avatarUrl: null,
    dateOfBirth: "1990-04-01",
    gender: "FEMALE",
    nationality: "IN",
    timezone: "Asia/Kolkata",
    languageCode: "en",
    address: { line1: "12 Private Road", city: "Hyderabad" },
    emergencyContact: { name: "John Doe", phone: "+1999999999" },
    linkedinUrl: null,
    githubUrl: null,
    bio: null,
    rowVersion: 1,
    archivedAt: null,
    archivedByMembershipId: null,
    updatedByMembershipId: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("directory person projection", () => {
  it("renders a select list that omits every onboarding-identity column", () => {
    const sql = renderedSelectList().toLowerCase();
    for (const column of RESTRICTED_SQL_COLUMNS)
      expect(sql).not.toContain(column);
    expect(sql).toContain("work_email");
    expect(sql).toContain("first_name");
  });

  it("declares every restricted column and never re-admits one to the projection", () => {
    expect(DIRECTORY_PERSON_RESTRICTED_COLUMNS.length).toBeGreaterThan(0);
    for (const column of DIRECTORY_PERSON_RESTRICTED_COLUMNS)
      expect(Object.keys(DIRECTORY_PERSON_COLUMNS)).not.toContain(column);
  });

  it("drops onboarding-identity values when narrowing a written row", () => {
    const narrowed = toDirectoryPerson(fullPersonRow());
    const keys = Object.keys(narrowed);
    for (const column of DIRECTORY_PERSON_RESTRICTED_COLUMNS)
      expect(keys).not.toContain(column);
    expect(narrowed.workEmail).toBe("jane@example.com");
    expect(narrowed.organizationPersonId).toBe("person-1");
  });

  it("fails when the fixture keeps a restricted column — the assertions are not vacuous", () => {
    const leaky = { ...toDirectoryPerson(fullPersonRow()), dateOfBirth: "1990-04-01" };
    expect(Object.keys(leaky)).toContain("dateOfBirth");
  });
});

describe("DirectoryService universal reads", () => {
  function serviceWithCapture() {
    const selected: unknown[] = [];
    const rows: unknown[] = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    const db = {
      select: (columns: unknown) => {
        selected.push(columns);
        return chain;
      },
    } as unknown as Db;
    const identities = {
      resolvePeopleAccess: jest.fn().mockResolvedValue([]),
      resolvePersonAccess: jest.fn().mockResolvedValue({}),
    } as unknown as DirectoryIdentityService;
    const service = new DirectoryService(
      db,
      {} as AuditService,
      identities,
      {} as WorkerEngagementsService,
    );
    return { service, selected, rows };
  }

  it("lists people through the safe projection, never a bare select", async () => {
    const { service, selected } = serviceWithCapture();
    await service.listPeople("org-1", { limit: 20 });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(DIRECTORY_PERSON_COLUMNS);
  });

  it("reads one person through the safe projection", async () => {
    const { service, selected, rows } = serviceWithCapture();
    rows.push(toDirectoryPerson(fullPersonRow()));
    await service.getPerson("org-1", "person-1");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(DIRECTORY_PERSON_COLUMNS);
  });
});
