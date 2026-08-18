import { ConflictException, NotFoundException } from "@nestjs/common";
import { DirectoryService } from "./directory.service";
import {
  createDirectoryTestHarness,
  makePerson,
  makeSelectChain,
  makeWorker,
  mockAudit,
  mockIdentities,
  ORG_ID,
  OTHER_ORG,
  PERSON_ID,
  USER_ID,
  WORKER_ID,
} from "./directory.service.spec-fixtures";

describe("DirectoryService worker operations", () => {
  let svc: DirectoryService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    const harness = await createDirectoryTestHarness();
    svc = harness.service;
    mockDb = harness.database;
  });

  describe("getWorker  -  BOLA cross-tenant isolation", () => {
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
  describe("createWorker  -  validates person exists first, then inserts", () => {
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
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
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
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
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
  // listWorkers  -  pagination envelope with innerJoin
  // ---------------------------------------------------------------------------

  describe("listWorkers - cursor envelope", () => {
    it("returns one bounded cursor page without a count query", async () => {
      const workerRows = [
        {
          ...makeWorker(),
          firstName: "Jane",
          lastName: "Doe",
          displayName: null,
          workEmail: "jane@example.com",
          avatarUrl: null,
        },
      ];
      let selectCount = 0;
      (mockDb as { select: jest.Mock }).select.mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return {
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  orderBy: jest.fn().mockReturnValue({
                    limit: jest.fn().mockResolvedValue(workerRows),
                  }),
                }),
              }),
            }),
          };
        }
        throw new Error("Unexpected exact-count query");
      });

      const result = await svc.listWorkers(ORG_ID, {
        limit: 20,
        search: "Jane",
      });

      expect(result.data).toHaveLength(1);
      expect(result.pageInfo).toEqual({
        limit: 20,
        hasMore: false,
        nextCursor: null,
      });
      expect((mockDb as { select: jest.Mock }).select).toHaveBeenCalledTimes(1);
    });
  });
});
