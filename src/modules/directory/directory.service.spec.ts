import { ConflictException, NotFoundException } from "@nestjs/common";
import { drizzlePostgresError, drizzleUniqueViolation } from "../../test/postgres-error-fixture";
import { DirectoryService } from "./directory.service";
import {
  createDirectoryTestHarness,
  makePerson,
  makeSelectChain,
  mockAudit,
  mockIdentities,
  ORG_ID,
  OTHER_ORG,
  PERSON_ID,
  USER_ID,
} from "./directory.service.spec-fixtures";

describe("DirectoryService person operations", () => {
  let svc: DirectoryService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    const harness = await createDirectoryTestHarness();
    svc = harness.service;
    mockDb = harness.database;
  });

  describe("getPerson  -  BOLA cross-tenant isolation", () => {
    it("throws 404 when person belongs to a different tenant (empty result)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPerson(OTHER_ORG, PERSON_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("throws 404 when person is soft-deleted (empty result)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPerson(ORG_ID, PERSON_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the person row when it belongs to the caller's tenant", async () => {
      const person = makePerson();
      const { selectChain } = makeSelectChain([person]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getPerson(ORG_ID, PERSON_ID)).resolves.toMatchObject({
        organizationPersonId: PERSON_ID,
        organizationId: ORG_ID,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // createPerson
  // ---------------------------------------------------------------------------
  describe("createPerson  -  23505  -  409 and audit-log on success", () => {
    it("maps Postgres unique violation to ConflictException", async () => {
      // A real rejected promise, so the service's own `.catch` runs: the old mock
      // replaced `.catch` with one that returned a ConflictException outright,
      // which passed whatever the handler did. uniq_org_people_org_work_email,
      // as drizzle surfaces it.
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockRejectedValue(drizzleUniqueViolation("uniq_org_people_org_work_email")),
        }),
      });

      await expect(
        svc.createPerson(ORG_ID, USER_ID, {
          firstName: "Jane",
          lastName: "Doe",
          workEmail: "jane@example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
    });

    it("rethrows any other database error untouched", async () => {
      const fkViolation = drizzlePostgresError("23503", "fk_org_people_membership");
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockRejectedValue(fkViolation),
        }),
      });

      await expect(
        svc.createPerson(ORG_ID, USER_ID, { firstName: "Jane", lastName: "Doe" }),
      ).rejects.toBe(fkViolation);
    });

    it("inserts and audit-logs on success", async () => {
      const row = makePerson({ organizationPersonId: PERSON_ID });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([row]),
          }),
        }),
      });

      const result = await svc.createPerson(ORG_ID, USER_ID, {
        firstName: "Jane",
        lastName: "Doe",
      });

      expect(result).toMatchObject({
        organizationPersonId: PERSON_ID,
        organizationId: ORG_ID,
      });
      expect(mockAudit.logCritical).toHaveBeenCalledTimes(1);
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.person.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "organization_person",
        }),
      );
    });

    it("links a matching organization membership when creating by work email", async () => {
      mockIdentities.resolveLinkForPersonWrite.mockResolvedValue({
        userId: USER_ID,
        organizationMembershipId: 42,
      });
      const values = jest.fn().mockReturnValue({
        returning: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue([
            makePerson({ userId: USER_ID, organizationMembershipId: 42 }),
          ]),
        }),
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({ values });

      await svc.createPerson(ORG_ID, USER_ID, {
        firstName: "Jane",
        lastName: "Doe",
        workEmail: " JANE@EXAMPLE.COM ",
      });

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          workEmail: "jane@example.com",
          userId: USER_ID,
          organizationMembershipId: 42,
        }),
      );
    });

    it("uses normalized personal email as the identity fallback", async () => {
      const row = makePerson({
        workEmail: null,
        personalEmail: "jane.personal@example.com",
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([row]),
          }),
        }),
      });

      await svc.createPerson(ORG_ID, USER_ID, {
        firstName: "Jane",
        lastName: "Doe",
        personalEmail: " JANE.PERSONAL@EXAMPLE.COM ",
      });

      expect(mockIdentities.resolveLinkForPersonWrite).toHaveBeenCalledWith(
        ORG_ID,
        expect.objectContaining({
          workEmail: undefined,
          personalEmail: "jane.personal@example.com",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updatePerson
  // ---------------------------------------------------------------------------
  describe("updatePerson  -  re-asserts access before writing", () => {
    it("throws 404 (via loadPerson) when the person is not in the caller's tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updatePerson(OTHER_ORG, USER_ID, PERSON_ID, { firstName: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when person exists", async () => {
      const existing = makePerson();
      const updated = makePerson({ firstName: "Updated" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockReturnValue({
              catch: jest.fn().mockResolvedValue([updated]),
            }),
          }),
        }),
      });

      const result = await svc.updatePerson(ORG_ID, USER_ID, PERSON_ID, {
        firstName: "Updated",
      });

      expect(result).toMatchObject({ firstName: "Updated" });
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.person.updated",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });

    it("maps Postgres unique violation (23505) to ConflictException on update", async () => {
      const existing = makePerson();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      // A real rejected promise, so the service's own `.catch` runs (see createPerson).
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest
              .fn()
              .mockRejectedValue(drizzleUniqueViolation("uniq_org_people_org_work_email")),
          }),
        }),
      });

      await expect(
        svc.updatePerson(ORG_ID, USER_ID, PERSON_ID, { workEmail: "taken@example.com" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("rethrows any other database error untouched on update", async () => {
      const { selectChain } = makeSelectChain([makePerson()]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      const fkViolation = drizzlePostgresError("23503", "fk_org_people_membership");
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockRejectedValue(fkViolation),
          }),
        }),
      });

      await expect(
        svc.updatePerson(ORG_ID, USER_ID, PERSON_ID, { workEmail: "taken@example.com" }),
      ).rejects.toBe(fkViolation);
    });
  });

  // ---------------------------------------------------------------------------
  // softDeletePerson
  // ---------------------------------------------------------------------------
  describe("softDeletePerson  -  soft delete", () => {
    it("throws 404 (via loadPerson) when person not in tenant (no write)", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.softDeletePerson(OTHER_ORG, USER_ID, PERSON_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets deletedAt and audit-logs when person exists", async () => {
      const existing = makePerson();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.softDeletePerson(ORG_ID, USER_ID, PERSON_ID);

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: expect.any(Date) }),
      );
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.person.deleted",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listPeople  -  pagination envelope
  // ---------------------------------------------------------------------------

  describe("listPeople - cursor envelope", () => {
    it("returns one bounded cursor page", async () => {
      const peopleRows = [
        makePerson(),
        makePerson({ organizationPersonId: "person-2" }),
      ];
      const limitQuery = jest.fn().mockResolvedValue(peopleRows);
      (mockDb as { select: jest.Mock }).select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: limitQuery }),
          }),
        }),
      });

      const result = await svc.listPeople(ORG_ID, { limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(result.pageInfo).toEqual({
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
      expect(mockIdentities.resolvePeopleAccess).toHaveBeenCalledWith(
        ORG_ID,
        peopleRows,
      );
      expect(limitQuery).toHaveBeenCalledWith(21);
    });

    it("returns the last included id as the next cursor", async () => {
      const peopleRows = Array.from({ length: 11 }, (_, personIndex) =>
        makePerson({
          organizationPersonId: `person-${String(personIndex).padStart(2, "0")}`,
        }),
      );
      const limitQuery = jest.fn().mockResolvedValue(peopleRows);
      (mockDb as { select: jest.Mock }).select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: limitQuery }),
          }),
        }),
      });

      const result = await svc.listPeople(ORG_ID, { limit: 10 });

      expect(result.data).toHaveLength(10);
      expect(result.pageInfo).toEqual({
        limit: 10,
        hasMore: true,
        nextCursor: "person-09",
      });
      expect(mockIdentities.resolvePeopleAccess).toHaveBeenCalledWith(
        ORG_ID,
        peopleRows.slice(0, 10),
      );
      expect(limitQuery).toHaveBeenCalledWith(11);
    });
  });
});
