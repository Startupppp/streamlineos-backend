import { ConflictException, NotFoundException } from "@nestjs/common";
import { DirectoryService } from "./directory.service";
import {
  createDirectoryTestHarness,
  ENGAGEMENT_ID,
  makeEngagement,
  makeSelectChain,
  mockAudit,
  ORG_ID,
  OTHER_ORG,
  USER_ID,
} from "./directory.service.spec-fixtures";

describe("DirectoryService engagement lifecycle", () => {
  let svc: DirectoryService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    const harness = await createDirectoryTestHarness();
    svc = harness.service;
    mockDb = harness.database;
  });

  describe("updateEngagement  -  re-asserts access before writing", () => {
    it("throws 404 (via loadEngagement) when engagement not in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.updateEngagement(OTHER_ORG, USER_ID, ENGAGEMENT_ID, { expectedVersion: 1, workerType: "PART_TIME" }),
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
          expectedVersion: 1,
        workerType: "PART_TIME",
      });

      expect(result).toMatchObject({ workerType: "PART_TIME" });
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
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
          expectedVersion: 1,
          startsOn: "2024-02-01",
        }),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "WORKER_ENGAGEMENT_DATE_OVERLAP",
        }),
      });
    });


    it("rejects a stale expected version without writing an audit event", async () => {
      const existing = makeEngagement({ rowVersion: 2 });
      const { selectChain } = makeSelectChain([existing]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      const returningQuery = jest.fn().mockResolvedValue([]);
      (mockDb as { update: jest.Mock }).update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ returning: returningQuery }),
        }),
      });

      await expect(
        svc.updateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {
          expectedVersion: 1,
          workerType: "PART_TIME",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(returningQuery).toHaveBeenCalledTimes(1);
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // cancelEngagement
  // ---------------------------------------------------------------------------
  describe("cancelEngagement  -  preserves history and frees planned dates", () => {
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
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
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
  describe("terminateEngagement  -  sets status=TERMINATED", () => {
    it("throws 404 (via loadEngagement) when engagement not in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.terminateEngagement(OTHER_ORG, USER_ID, ENGAGEMENT_ID, {
          expectedVersion: 1,
        }),
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
          expectedVersion: 1,
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
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
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

      await svc.terminateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, { expectedVersion: 1 });

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          endsOn: "2024-06-30",
        }),
      );
    });


    it("rejects termination of a planned engagement", async () => {
      const plannedEngagement = makeEngagement({
        status: "PLANNED",
        isPrimary: false,
      });
      const { selectChain } = makeSelectChain([plannedEngagement]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.terminateEngagement(ORG_ID, USER_ID, ENGAGEMENT_ID, {
          expectedVersion: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
    });
  });
});
