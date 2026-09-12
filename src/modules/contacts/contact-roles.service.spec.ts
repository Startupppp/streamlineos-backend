import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ContactRolesService } from "./contact-roles.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AuditService } from "../../common/audit/audit.service";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";

/**
 * The role-conflict half of fix/unique-violation-409's contact-roles spec.
 *
 * Its merge-contacts cases went with the merge mechanism they tested: the CRM
 * lane retired `mergeContacts` from this service in favour of the one Party
 * merge (e65cc7c53). What survives is `addRole`'s answer to a duplicate, and it
 * is pinned with the error Drizzle really throws — a `DrizzleQueryError` with
 * the SQLSTATE on `.cause` — not a bare `{ code: "23505" }` that any handler
 * reading the wrong object would also satisfy.
 */
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  };
}

describe("ContactRolesService – addRole", () => {
  const ORG_A = "org-a";
  const input = { entityType: "deal" as const, entityId: 5, roleKey: "champion", isPrimary: false };
  let svc: ContactRolesService;
  let db: ReturnType<typeof makeDb>;

  beforeEach(async () => {
    db = makeDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContactRolesService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();
    svc = module.get(ContactRolesService);
    // The contact-access check finds the contact in the org.
    db.where.mockResolvedValueOnce([{ id: 1 }]);
  });

  it("throws ConflictException when the contact already holds the role on that entity", async () => {
    // uniq_crm_contact_roles_combo, as Drizzle surfaces it.
    db.returning.mockRejectedValueOnce(drizzleUniqueViolation("uniq_crm_contact_roles_combo"));

    await expect(svc.addRole(ORG_A, 1, input, "user-1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("rethrows any other database error untouched", async () => {
    const fkViolation = drizzlePostgresError("23503", "fk_crm_contact_roles_contact");
    db.returning.mockRejectedValueOnce(fkViolation);

    await expect(svc.addRole(ORG_A, 1, input, "user-1")).rejects.toBe(fkViolation);
  });
});
