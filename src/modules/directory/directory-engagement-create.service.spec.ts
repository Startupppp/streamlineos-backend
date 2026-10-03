import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { DirectoryService } from "./directory.service";
import {
  createDirectoryTestHarness,
  ENGAGEMENT_ID,
  makeEngagement,
  makeSelectChain,
  makeWorker,
  mockAudit,
  ORG_ID,
  OTHER_ORG,
  USER_ID,
  WORKER_ID,
} from "./directory.service.spec-fixtures";

describe("DirectoryService engagement creation and listing", () => {
  let svc: DirectoryService;
  let mockDb: Record<string, unknown>;

  beforeEach(async () => {
    const harness = await createDirectoryTestHarness();
    svc = harness.service;
    mockDb = harness.database;
    (mockDb as { update: jest.Mock }).update.mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    });
  });

  describe("listEngagements  -  validates worker exists first", () => {
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
        // listEngagements chain: .select().from().where() (no limit  -  returns promise directly)
        return { from: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([engagement]) }) };
      });

      const result = await svc.listEngagements(ORG_ID, WORKER_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ workerId: WORKER_ID });
    });
  });

  // ---------------------------------------------------------------------------
  // createEngagement  -  isPrimary sets status=ACTIVE
  // ---------------------------------------------------------------------------
  describe("createEngagement  -  status and database conflict mapping", () => {
    it("throws 404 when the worker does not exist in tenant", async () => {
      const { selectChain } = makeSelectChain([]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, null, {
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

      await svc.createEngagement(ORG_ID, USER_ID, null, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
        isPrimary: true,
      });

      expect(valuesSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ACTIVE", isPrimary: true }),
      );
    });

    it("activates an INACTIVE worker in the same write path when the engagement starts ACTIVE", async () => {
      const { selectChain } = makeSelectChain([makeWorker({ status: "INACTIVE" })]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([makeEngagement({ status: "ACTIVE", isPrimary: true })]),
          }),
        }),
      });
      const where = jest.fn().mockResolvedValue([]);
      const set = jest.fn().mockReturnValue({ where });
      (mockDb as { update: jest.Mock }).update.mockReturnValue({ set });

      await svc.createEngagement(ORG_ID, USER_ID, null, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
        isPrimary: true,
      });

      expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "ACTIVE" }));
      const predicate = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
      expect(predicate.sql).toContain('"status" = ');
      expect(predicate.sql).toContain('"deleted_at" is null');
      expect(predicate.params).toEqual(expect.arrayContaining([WORKER_ID, ORG_ID, "INACTIVE"]));
      expect(predicate.params).not.toContain("EXITED");
    });

    it("leaves the worker alone when the engagement is only PLANNED", async () => {
      const { selectChain } = makeSelectChain([makeWorker({ status: "INACTIVE" })]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);
      (mockDb as { insert: jest.Mock }).insert.mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockReturnValue({
            catch: jest.fn().mockResolvedValue([makeEngagement({ status: "PLANNED", isPrimary: false })]),
          }),
        }),
      });

      await svc.createEngagement(ORG_ID, USER_ID, null, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
        isPrimary: false,
      });

      expect((mockDb as { update: jest.Mock }).update).not.toHaveBeenCalled();
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

      await svc.createEngagement(ORG_ID, USER_ID, null, {
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
        svc.createEngagement(ORG_ID, USER_ID, null, {
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
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
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
        svc.createEngagement(ORG_ID, USER_ID, null, {
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
      expect(mockAudit.logCritical).not.toHaveBeenCalled();
    });

    it("rejects an end date before the start date before inserting", async () => {
      const worker = makeWorker();
      const { selectChain } = makeSelectChain([worker]);
      (mockDb as { select: jest.Mock }).select.mockReturnValue(selectChain);

      await expect(
        svc.createEngagement(ORG_ID, USER_ID, null, {
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

      const result = await svc.createEngagement(ORG_ID, USER_ID, null, {
        workerId: WORKER_ID,
        startsOn: "2024-01-01",
        workerType: "FULL_TIME",
      });

      expect(result).toMatchObject({ workerEngagementId: ENGAGEMENT_ID });
      expect(mockAudit.logCritical).toHaveBeenCalledWith(
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
});
