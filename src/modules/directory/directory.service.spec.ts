import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DirectoryService } from "./directory.service";
import { AuditService } from "../../common/audit/audit.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { DirectoryIdentityService } from "./directory-identity.service";

const ORG_ID = "org-aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ORG = "org-aaaaaaaa-0000-0000-0000-000000000099";
const USER_ID = "user-aaaa-0000-0000-0000-000000000001";
const PERSON_ID = "person-aa-0000-0000-0000-000000000001";
const WORKER_ID = "worker-aa-0000-0000-0000-000000000001";
const ENGAGEMENT_ID = "engage-aa-0000-0000-0000-000000000001";

const mockAudit = { log: jest.fn() } as unknown as AuditService;
const mockIdentities = {
  reconcilePersonIdentity: jest.fn(),
  resolveLinkForPersonWrite: jest.fn(),
  ensurePersonForMember: jest.fn(),
  resolvePersonAccess: jest.fn(),
  resolvePeopleAccess: jest.fn(),
};

function makePerson(overrides: Record<string, unknown> = {}) {
  return {
    organizationPersonId: PERSON_ID,
    organizationId: ORG_ID,
    firstName: "Jane",
    lastName: "Doe",
    displayName: null,
    preferredName: null,
    workEmail: "jane@example.com",
    personalEmail: null,
    phone: null,
    whatsappNumber: null,
    avatarUrl: null,
    dateOfBirth: null,
    gender: null,
    nationality: null,
    timezone: null,
    languageCode: null,
    linkedinUrl: null,
    githubUrl: null,
    bio: null,
    userId: null,
    organizationMembershipId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makeWorker(overrides: Record<string, unknown> = {}) {
  return {
    workerId: WORKER_ID,
    organizationId: ORG_ID,
    organizationPersonId: PERSON_ID,
    workerNumber: "W-001",
    status: "ACTIVE",
    isPayee: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEngagement(overrides: Record<string, unknown> = {}) {
  return {
    workerEngagementId: ENGAGEMENT_ID,
    organizationId: ORG_ID,
    workerId: WORKER_ID,
    startsOn: "2024-01-01",
    endsOn: null,
    workerType: "FULL_TIME",
    status: "ACTIVE",
    isPrimary: true,
    designation: "Engineer",
    departmentId: null,
    businessUnitId: null,
    branchId: null,
    locationId: null,
    teamId: null,
    managerEngagementId: null,
    jobRoleId: null,
    jobLevelId: null,
    employmentTypeId: null,
    probationEndsOn: null,
    noticePeriodDays: null,
    terminationReason: null,
    terminationNotes: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("DirectoryService", () => {
  let svc: DirectoryService;
  let mockDb: Record<string, unknown>;

  /** Returns a chain: .select().from().where().limit() */
  function makeSelectChain(rows: unknown[]) {
    const limitFn = jest.fn().mockResolvedValue(rows);
    const whereChain = { limit: limitFn };
    const fromChain = { where: jest.fn().mockReturnValue(whereChain) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain, whereChain };
  }

  /** Returns a chain: .select().from().where() (no limit — for listEngagements count select) */
  function _makeSelectChainNoLimit(rows: unknown[]) {
    const fromChain = { where: jest.fn().mockResolvedValue(rows) };
    const selectChain = { from: jest.fn().mockReturnValue(fromChain) };
    return { selectChain, fromChain };
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    mockIdentities.reconcilePersonIdentity.mockImplementation(
      async (_organizationId: string, person: unknown) => person,
    );
    mockIdentities.resolvePersonAccess.mockImplementation(
      async (_organizationId: string, person: unknown) => person,
    );
    mockIdentities.resolvePeopleAccess.mockImplementation(
      async (_organizationId: string, people: unknown[]) => people,
    );
    mockIdentities.resolveLinkForPersonWrite.mockResolvedValue(null);

    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      query: {},
    };

    const module = await Test.createTestingModule({
      providers: [
        DirectoryService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: AuditService, useValue: mockAudit },
        { provide: DirectoryIdentityService, useValue: mockIdentities },
      ],
    }).compile();

    svc = module.get(DirectoryService);
  });

  // ---------------------------------------------------------------------------
  // getPerson / loadPerson — BOLA + soft-delete
  // ---------------------------------------------------------------------------
  describe("getPerson — BOLA cross-tenant isolation", () => {
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
  describe("createPerson — 23505 → 409 and audit-log on success", () => {
    it("maps Postgres unique violation to ConflictException", async () => {
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockRejectedValue(new ConflictException(
              "A person with this work email already exists in this organization.",
            )),
          }),
        }),
      });

      await expect(
        svc.createPerson(ORG_ID, USER_ID, {
          firstName: "Jane",
          lastName: "Doe",
          workEmail: "jane@example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
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
      expect(mockAudit.log).toHaveBeenCalledTimes(1);
      expect(mockAudit.log).toHaveBeenCalledWith(
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
  describe("updatePerson — re-asserts access before writing", () => {
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
      expect(mockAudit.log).toHaveBeenCalledWith(
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
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockReturnValue({
              catch: jest.fn().mockRejectedValue(new ConflictException(
                "A person with this work email already exists in this organization.",
              )),
            }),
          }),
        }),
      });

      await expect(
        svc.updatePerson(ORG_ID, USER_ID, PERSON_ID, { workEmail: "taken@example.com" }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ---------------------------------------------------------------------------
  // softDeletePerson
  // ---------------------------------------------------------------------------
  describe("softDeletePerson — soft delete", () => {
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
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.person.deleted",
          orgId: ORG_ID,
          userId: USER_ID,
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listPeople — pagination envelope
  // ---------------------------------------------------------------------------
  describe("listPeople — pagination envelope", () => {
    it("returns { data, pagination } with correct totalPages", async () => {
      const rows = [makePerson(), makePerson({ organizationPersonId: "person-2" })];

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // First parallel select: data rows — .select().from().where().limit().offset()
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  offset: jest.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          };
        }
        // Second parallel select: count — .select({total}).from().where()
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 2 }]),
          }),
        };
      });

      const result = await svc.listPeople(ORG_ID, { page: 1, limit: 20 });

      expect(result.data).toHaveLength(2);
      expect(mockIdentities.resolvePeopleAccess).toHaveBeenCalledTimes(1);
      expect(mockIdentities.resolvePeopleAccess).toHaveBeenCalledWith(
        ORG_ID,
        rows,
      );
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it("computes totalPages correctly for multiple pages", async () => {
      const rows = Array.from({ length: 5 }, (_, i) =>
        makePerson({ organizationPersonId: `person-${i}` }),
      );

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  offset: jest.fn().mockResolvedValue(rows),
                }),
              }),
            }),
          };
        }
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ total: 23 }]),
          }),
        };
      });

      const result = await svc.listPeople(ORG_ID, { page: 1, limit: 10 });

      expect(result.pagination.total).toBe(23);
      expect(result.pagination.totalPages).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // getWorker / loadWorker — BOLA
  // ---------------------------------------------------------------------------
  describe("getWorker — BOLA cross-tenant isolation", () => {
    it("throws 404 when worker belongs to a different tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getWorker(OTHER_ORG, WORKER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns the worker when it belongs to the caller's tenant", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(svc.getWorker(ORG_ID, WORKER_ID)).resolves.toMatchObject({
        workerId: WORKER_ID,
        organizationId: ORG_ID,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // createWorker
  // ---------------------------------------------------------------------------
  describe("createWorker — validates person exists first, then inserts", () => {
    it("throws 404 when the person does not exist in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createWorker(ORG_ID, USER_ID, {
          organizationPersonId: PERSON_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("maps Postgres unique violation to ConflictException", async () => {
      const person = makePerson();
      const { selectChain } = makeSelectChain([person]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockRejectedValue(
              new ConflictException("This person is already a worker in this organization."),
            ),
          }),
        }),
      });

      await expect(
        svc.createWorker(ORG_ID, USER_ID, { organizationPersonId: PERSON_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const person = makePerson();
      const worker = makeWorker({ workerId: WORKER_ID });
      const { selectChain } = makeSelectChain([person]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([worker]),
          }),
        }),
      });

      const result = await svc.createWorker(ORG_ID, USER_ID, {
        organizationPersonId: PERSON_ID,
        isPayee: false,
      });

      expect(result).toMatchObject({ workerId: WORKER_ID, organizationId: ORG_ID });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.worker.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "worker",
        }),
      );
    });

    it("creates the missing person record when a member is selected", async () => {
      const person = makePerson({
        userId: USER_ID,
        organizationMembershipId: 42,
      });
      const worker = makeWorker();
      mockIdentities.ensurePersonForMember.mockResolvedValue(person);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([worker]),
          }),
        }),
      });

      await expect(
        svc.createWorker(ORG_ID, USER_ID, { memberUserId: USER_ID }),
      ).resolves.toMatchObject({ workerId: WORKER_ID });
      expect(mockIdentities.ensurePersonForMember).toHaveBeenCalledWith(
        ORG_ID,
        USER_ID,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listWorkers — pagination envelope with innerJoin
  // ---------------------------------------------------------------------------
  describe("listWorkers — pagination envelope", () => {
    it("returns { data, pagination } with correct totalPages", async () => {
      const rows = [
        { ...makeWorker(), firstName: "Jane", lastName: "Doe", displayName: null, workEmail: "jane@example.com", avatarUrl: null },
      ];

      let selectCount = 0;
      const countWhere = jest.fn().mockResolvedValue([{ total: 1 }]);
      const countInnerJoin = jest.fn().mockReturnValue({ where: countWhere });
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // Data rows: .select({...}).from().innerJoin().where().limit().offset()
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue(rows),
                  }),
                }),
              }),
            }),
          };
        }
        // Count mirrors the person join because search filters use person fields.
        return {
          from: jest.fn().mockReturnValue({
            innerJoin: countInnerJoin,
          }),
        };
      });

      const result = await svc.listWorkers(ORG_ID, {
        page: 1,
        limit: 20,
        search: "Jane",
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(countInnerJoin).toHaveBeenCalledTimes(1);
      expect(countWhere).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // listEngagements
  // ---------------------------------------------------------------------------
  describe("listEngagements — validates worker exists first", () => {
    it("throws 404 when worker not in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.listEngagements(OTHER_ORG, WORKER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns engagement rows when worker exists", async () => {
      const worker = makeWorker();
      const engagement = makeEngagement();

      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          // loadWorker chain: .select().from().where().limit()
          const limitFn = jest.fn().mockResolvedValue([worker]);
          return { from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: limitFn }) }) };
        }
        // listEngagements chain: .select().from().where() (no limit — returns promise directly)
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([engagement]) }) };
      });

      const result = await svc.listEngagements(ORG_ID, WORKER_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ workerId: WORKER_ID });
    });
  });

  // ---------------------------------------------------------------------------
  // createEngagement — isPrimary sets status=ACTIVE
  // ---------------------------------------------------------------------------
  describe("createEngagement — status and database conflict mapping", () => {
    it("throws 404 when the worker does not exist in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, {
          workerId: WORKER_ID,
          startsOn: "2024-01-01",
          workerType: "FULL_TIME",
          isPrimary: true,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("sets status=ACTIVE when isPrimary=true", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const engagement = makeEngagement({ status: "ACTIVE", isPrimary: true });
      const valuesSpy = jest.fn().mockReturnValue({
        returning: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue([engagement]),
        }),
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({ values: valuesSpy });

      await svc.createEngagement(ORG_ID, USER_ID, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
        isPrimary: true,
      });

      expect(valuesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ACTIVE", isPrimary: true }),
      );
    });

    it("sets status=PLANNED when isPrimary=false", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const engagement = makeEngagement({ status: "PLANNED", isPrimary: false });
      const valuesSpy = jest.fn().mockReturnValue({
        returning: jest.fn().mockReturnValue({
          catch: jest.fn().mockResolvedValue([engagement]),
        }),
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({ values: valuesSpy });

      await svc.createEngagement(ORG_ID, USER_ID, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
        isPrimary: false,
      });

      expect(valuesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: "PLANNED" }),
      );
    });

    it("maps a wrapped Postgres unique violation to an actionable 409", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const drizzleError = Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "uniq_worker_engagements_active_primary",
        }),
      });

      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn((onRejected: (error: unknown) => never) =>
              Promise.reject(drizzleError).catch(onRejected),
            ),
          }),
        }),
      });

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, {
          workerId: WORKER_ID,
          startsOn: "2024-01-01",
          workerType: "FULL_TIME",
          isPrimary: true,
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_PRIMARY_ENGAGEMENT_EXISTS",
          message: expect.stringContaining("active primary engagement"),
        }),
      });
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("maps a wrapped exclusion violation to an actionable overlap 409", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const drizzleError = Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("conflicting key"), {
          code: "23P01",
          constraint: "excl_worker_engagements_overlap",
        }),
      });
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn((onRejected: (error: unknown) => never) =>
              Promise.reject(drizzleError).catch(onRejected),
            ),
          }),
        }),
      });

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, {
          workerId: WORKER_ID,
          startsOn: "2024-02-01",
          workerType: "FULL_TIME",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_ENGAGEMENT_DATE_OVERLAP",
          message: expect.stringContaining("planned or active engagement"),
        }),
      });
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it("rejects an end date before the start date before inserting", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, {
          workerId: WORKER_ID,
          startsOn: "2024-02-02",
          endsOn: "2024-02-01",
          workerType: "FULL_TIME",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_ENGAGEMENT_INVALID_DATES",
        }),
      });
      expect((mockDb as { insert: jest.Mock }).insert).not.toHaveBeenCalled();
    });

    it("inserts and audit-logs on success", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const engagement = makeEngagement();
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([engagement]),
          }),
        }),
      });

      const result = await svc.createEngagement(ORG_ID, USER_ID, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
      });

      expect(result).toMatchObject({ workerEngagementId: ENGAGEMENT_ID });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.engagement.created",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "worker_engagement",
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // updateEngagement
  // ---------------------------------------------------------------------------
  describe("updateEngagement — re-asserts access before writing", () => {
    it("throws 404 (via loadEngagement) when engagement not in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateEngagement(OTHER_ORG, USER_ID, ENGAGEMENT_ID, { workerType: "PART_TIME" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("applies the patch and audit-logs when engagement exists", async () => {
      const existing = makeEngagement();
      const updatedEngagement = makeEngagement({ workerType: "PART_TIME" });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockReturnValue({
              catch: jest.fn().mockResolvedValue([updatedEngagement]),
            }),
          }),
        }),
      });

      const result = await svc.updateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {
        workerType: "PART_TIME",
      });

      expect(result).toMatchObject({ workerType: "PART_TIME" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.engagement.updated",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "worker_engagement",
        }),
      );
    });

    it("maps a wrapped Postgres exclusion violation on update", async () => {
      const existing = makeEngagement();
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const drizzleError = Object.assign(new Error("Failed query"), {
        cause: Object.assign(new Error("conflicting key"), {
          code: "23P01",
          constraint: "excl_worker_engagements_overlap",
        }),
      });

      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockReturnValue({
              catch: jest.fn((onRejected: (error: unknown) => never) =>
                Promise.reject(drizzleError).catch(onRejected),
              ),
            }),
          }),
        }),
      });

      await expect(
        svc.updateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {
          startsOn: "2024-02-01",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_ENGAGEMENT_DATE_OVERLAP",
        }),
      });
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEngagement
  // ---------------------------------------------------------------------------
  describe("cancelEngagement — preserves history and frees planned dates", () => {
    it("changes a planned engagement to CANCELLED and audit-logs", async () => {
      const existing = makeEngagement({ status: "PLANNED", isPrimary: false });
      const cancelled = makeEngagement({
        status: "CANCELLED",
        isPrimary: false,
      });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([cancelled]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      const result = await svc.cancelEngagement(
        ORG_ID,
        USER_ID,
        ENGAGEMENT_ID,
      );

      expect(setSpy).toHaveBeenCalledWith({
        status: "CANCELLED",
        isPrimary: false,
      });
      expect(result).toMatchObject({ status: "CANCELLED" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.engagement.cancelled",
          resourceId: ENGAGEMENT_ID,
        }),
      );
    });

    it("does not cancel an active engagement", async () => {
      const { selectChain } = makeSelectChain([
        makeEngagement({ status: "ACTIVE" }),
      ]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.cancelEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_ENGAGEMENT_NOT_PLANNED",
        }),
      });
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // terminateEngagement
  // ---------------------------------------------------------------------------
  describe("terminateEngagement — sets status=TERMINATED", () => {
    it("throws 404 (via loadEngagement) when engagement not in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.terminateEngagement(OTHER_ORG, USER_ID, ENGAGEMENT_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
    });

    it("sets status=TERMINATED and audit-logs when engagement exists", async () => {
      const existing = makeEngagement();
      const terminated = makeEngagement({ status: "TERMINATED", terminationReason: "Resigned" });

      let _selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        _selectCount++;
        // loadEngagement: .select().from().where().limit()
        const limitFn = jest.fn().mockResolvedValue([existing]);
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: limitFn }),
          }),
        };
      });

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([terminated]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      const result = await svc.terminateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {
        terminationReason: "Resigned",
        endsOn: "2024-12-31",
      });

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "TERMINATED",
          terminationReason: "Resigned",
        }),
      );
      expect(result).toMatchObject({ status: "TERMINATED" });
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "directory.engagement.terminated",
          orgId: ORG_ID,
          userId: USER_ID,
          resourceType: "worker_engagement",
        }),
      );
    });

    it("uses existing endsOn when not provided in input", async () => {
      const existing = makeEngagement({ endsOn: "2024-06-30" });

      let _selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        _selectCount++;
        const limitFn = jest.fn().mockResolvedValue([existing]);
        return {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: limitFn }),
          }),
        };
      });

      const setSpy = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([existing]),
        }),
      });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set: setSpy });

      await svc.terminateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {});

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endsOn: "2024-06-30",
        }),
      );
    });
  });
});
