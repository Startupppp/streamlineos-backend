jest.mock("../../../common/tenant", () => ({
  forEachOrg: async (
    _db: unknown,
    _name: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn((globalThis as { __helpdeskCronTx?: unknown }).__helpdeskCronTx, "org-test");
    return { organizations: 1, succeeded: 1, failed: 0 };
  },
}));

import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CronHelpdeskRetentionService } from "../cron-helpdesk-retention.service";

interface DeleteChain {
  where: jest.Mock;
}

interface InsertChain {
  values: jest.Mock;
}

interface MockTx {
  delete: jest.Mock<DeleteChain>;
  insert: jest.Mock<InsertChain>;
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
  (globalThis as { __helpdeskCronTx?: unknown }).__helpdeskCronTx = tx;
  return tx;
}

function getInsertValues(tx: MockTx): jest.Mock {
  return (tx.insert.mock.results[0]?.value as { values: jest.Mock } | undefined)?.values ?? jest.fn();
}

async function buildService(): Promise<CronHelpdeskRetentionService> {
  const module = await Test.createTestingModule({
    providers: [
      CronHelpdeskRetentionService,
      { provide: DRIZZLE, useValue: {} },
    ],
  }).compile();
  return module.get(CronHelpdeskRetentionService);
}

describe("CronHelpdeskRetentionService", () => {
  let service: CronHelpdeskRetentionService;

  beforeEach(async () => {
    service = await buildService();
  });

  describe("legal-hold exclusion", () => {
    it("reports 0 deleted when the database WHERE clause filters out all hold-covered rows", async () => {
      makeTx([]);
      const result = await service.sweep();
      expect(result.ticketsDeleted).toBe(0);
    });

    it("reports 1 deleted when the row is not under a hold (hold released path)", async () => {
      makeTx([{ id: "ticket-1" }]);
      const result = await service.sweep();
      expect(result.ticketsDeleted).toBe(1);
    });
  });

  describe("audit logging", () => {
    it("writes an audit record to hr_audit_logs when rows are deleted", async () => {
      const tx = makeTx([{ id: "ticket-1" }]);
      await service.sweep();
      const values = getInsertValues(tx);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "retention_sweep.helpdesk_tickets",
          entityType: "helpdesk_ticket_batch",
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
    it("accumulates up to 200 deletions per org per sweep (BATCH_SIZE=200)", async () => {
      makeTx(new Array(200).fill(null).map((_, i) => ({ id: `ticket-${i}` })));
      const result = await service.sweep();
      expect(result.ticketsDeleted).toBe(200);
    });
  });

  describe("idempotency", () => {
    it("a second sweep against an already-empty table deletes nothing more", async () => {
      makeTx([{ id: "ticket-1" }]);
      const first = await service.sweep();
      expect(first.ticketsDeleted).toBe(1);

      makeTx([]);
      const second = await service.sweep();
      expect(second.ticketsDeleted).toBe(0);
    });
  });
});
