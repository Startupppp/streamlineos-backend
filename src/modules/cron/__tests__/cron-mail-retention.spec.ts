jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as { __mailCronTx?: unknown }).__mailCronTx, "org-test");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CronMailRetentionService } from "../cron-mail-retention.service";

interface MockTx {
  delete: jest.Mock;
  insert: jest.Mock;
}

function makeTx(deleteRows: Array<{ id: string }>): MockTx {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const tx: MockTx = {
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(deleteRows),
      }),
    }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
  };
  (globalThis as { __mailCronTx?: unknown }).__mailCronTx = tx;
  return tx;
}

function getInsertValues(tx: MockTx): jest.Mock {
  return (tx.insert.mock.results[0]?.value as { values: jest.Mock } | undefined)?.values ?? jest.fn();
}

async function buildService(): Promise<CronMailRetentionService> {
  const module = await Test.createTestingModule({
    providers: [
      CronMailRetentionService,
      { provide: DRIZZLE, useValue: {} },
    ],
  }).compile();
  return module.get(CronMailRetentionService);
}

describe("CronMailRetentionService", () => {
  let service: CronMailRetentionService;

  beforeEach(async () => {
    service = await buildService();
  });

  describe("no legal-hold interaction", () => {
    it("deletes rows without a legal-hold gate (mail is a re-syncable projection)", async () => {
      makeTx([{ id: "msg-1" }, { id: "msg-2" }]);
      const result = await service.sweep();
      expect(result.rowsDeleted).toBe(2);
    });

    it("reports 0 deleted when no rows are eligible (past cutoff = none)", async () => {
      makeTx([]);
      const result = await service.sweep();
      expect(result.rowsDeleted).toBe(0);
    });
  });

  describe("audit logging", () => {
    it("writes an audit record to hr_audit_logs when rows are deleted", async () => {
      const tx = makeTx([{ id: "msg-1" }]);
      await service.sweep();
      const values = getInsertValues(tx);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "retention_sweep.mail_message_metadata",
          entityType: "mail_message_metadata_batch",
          entityId: "retention_sweep",
        }),
      );
    });

    it("does not write an audit record when nothing was deleted", async () => {
      const tx = makeTx([]);
      await service.sweep();
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });

  describe("boundedness", () => {
    it("accumulates up to 500 deletions per org per sweep (BATCH_SIZE=500)", async () => {
      makeTx(new Array(500).fill(null).map((_, i) => ({ id: `msg-${i}` })));
      const result = await service.sweep();
      expect(result.rowsDeleted).toBe(500);
    });
  });

  describe("idempotency", () => {
    it("a second sweep against an already-empty table deletes nothing more", async () => {
      makeTx([{ id: "msg-1" }]);
      const first = await service.sweep();
      expect(first.rowsDeleted).toBe(1);

      makeTx([]);
      const second = await service.sweep();
      expect(second.rowsDeleted).toBe(0);
    });
  });
});
