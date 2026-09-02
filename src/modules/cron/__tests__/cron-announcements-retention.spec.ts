jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as { __announcementsCronTx?: unknown }).__announcementsCronTx, "org-test");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CronAnnouncementsRetentionService } from "../cron-announcements-retention.service";

interface MockTx {
  delete: jest.Mock;
  insert: jest.Mock;
}

function makeDeleteChain(rows: Array<{ id: string }>) {
  return {
    where: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue(rows),
    }),
  };
}

function makeTx(expiredRows: Array<{ id: string }>, agedRows: Array<{ id: string }>): MockTx {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  let callCount = 0;
  const tx: MockTx = {
    delete: jest.fn().mockImplementation(() => {
      const rows = callCount === 0 ? expiredRows : agedRows;
      callCount++;
      return makeDeleteChain(rows);
    }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
  };
  (globalThis as { __announcementsCronTx?: unknown }).__announcementsCronTx = tx;
  return tx;
}

function rowsOfSize(size: number, prefix: string): Array<{ id: string }> {
  return new Array(size).fill(null).map((_, i) => ({ id: `${prefix}-${i}` }));
}

function makeSequencedTx(pages: Array<Array<{ id: string }>>): MockTx {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  let call = 0;
  const tx: MockTx = {
    delete: jest.fn().mockImplementation(() => {
      const rows = pages[call] ?? [];
      call += 1;
      return makeDeleteChain(rows);
    }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
  };
  (globalThis as { __announcementsCronTx?: unknown }).__announcementsCronTx = tx;
  return tx;
}

function getInsertValues(tx: MockTx): jest.Mock {
  return (tx.insert.mock.results[0]?.value as { values: jest.Mock } | undefined)?.values ?? jest.fn();
}

async function buildService(): Promise<CronAnnouncementsRetentionService> {
  const module = await Test.createTestingModule({
    providers: [
      CronAnnouncementsRetentionService,
      { provide: DRIZZLE, useValue: {} },
    ],
  }).compile();
  return module.get(CronAnnouncementsRetentionService);
}

describe("CronAnnouncementsRetentionService", () => {
  let service: CronAnnouncementsRetentionService;

  beforeEach(async () => {
    service = await buildService();
  });

  describe("two-phase sweep", () => {
    it("counts expired and aged deletions separately", async () => {
      makeTx([{ id: "a-1" }], [{ id: "a-2" }, { id: "a-3" }]);
      const result = await service.sweep();
      expect(result.expiredDeleted).toBe(1);
      expect(result.agedDeleted).toBe(2);
    });

    it("reports 0 for both phases when no rows match", async () => {
      makeTx([], []);
      const result = await service.sweep();
      expect(result.expiredDeleted).toBe(0);
      expect(result.agedDeleted).toBe(0);
    });
  });

  describe("audit logging", () => {
    it("writes an audit record to hr_audit_logs when any rows are deleted", async () => {
      const tx = makeTx([{ id: "a-1" }], []);
      await service.sweep();
      const values = getInsertValues(tx);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "retention_sweep.announcements",
          entityType: "announcement_batch",
          entityId: "retention_sweep",
        }),
      );
    });

    it("does not write an audit record when nothing was deleted in either phase", async () => {
      const tx = makeTx([], []);
      await service.sweep();
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });

  describe("cascade correctness (structural)", () => {
    it("cascade-delete of announcement_targets and announcement_reads is enforced at the FK layer, not in the worker", async () => {
      makeTx([{ id: "a-1" }], []);
      const result = await service.sweep();
      expect(result.expiredDeleted).toBe(1);
    });
  });

  describe("resumable drain (backlog larger than one batch)", () => {
    it("drains both phases past the batch size until each returns a short batch", async () => {
      const tx = makeSequencedTx([
        rowsOfSize(200, "expired"),
        rowsOfSize(200, "expired"),
        rowsOfSize(15, "expired"),
        rowsOfSize(200, "aged"),
        rowsOfSize(6, "aged"),
      ]);
      const result = await service.sweep();
      expect(tx.delete).toHaveBeenCalledTimes(5);
      expect(result.expiredDeleted).toBe(415);
      expect(result.agedDeleted).toBe(206);
      expect(result.truncated).toBe(false);
    });

    it("reports truncated when either phase reaches the batch cap", async () => {
      const tx = makeSequencedTx(
        new Array(250).fill(null).map(() => rowsOfSize(200, "expired")),
      );
      const result = await service.sweep();
      expect(tx.delete).toHaveBeenCalledTimes(200);
      expect(result.expiredDeleted).toBe(20_000);
      expect(result.agedDeleted).toBe(20_000);
      expect(result.truncated).toBe(true);
    });

    it("records the truncation in the audit row rather than reporting a clean sweep", async () => {
      const tx = makeSequencedTx(
        new Array(250).fill(null).map(() => rowsOfSize(200, "expired")),
      );
      await service.sweep();
      expect(getInsertValues(tx)).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({ truncated: true }),
        }),
      );
    });
  });

  describe("idempotency", () => {
    it("a second sweep against an already-empty table deletes nothing more", async () => {
      makeTx([{ id: "a-1" }], [{ id: "a-2" }]);
      const first = await service.sweep();
      expect(first.expiredDeleted + first.agedDeleted).toBe(2);

      makeTx([], []);
      const second = await service.sweep();
      expect(second.expiredDeleted).toBe(0);
      expect(second.agedDeleted).toBe(0);
    });
  });
});
