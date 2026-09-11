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

function rowsOfSize(size: number): Array<{ id: string }> {
  return new Array(size).fill(null).map((_, i) => ({ id: `ticket-${i}` }));
}

function makeSequencedTx(pages: Array<Array<{ id: string }>>): MockTx {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  let call = 0;
  const tx: MockTx = {
    delete: jest.fn().mockImplementation(() => {
      const rows = pages[call] ?? [];
      call += 1;
      return {
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(rows),
        }),
      };
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

  describe("resumable drain (backlog larger than one batch)", () => {
    it("keeps deleting until a short batch proves the backlog is exhausted", async () => {
      const tx = makeSequencedTx([rowsOfSize(200), rowsOfSize(200), rowsOfSize(37)]);
      const result = await service.sweep();
      expect(tx.delete).toHaveBeenCalledTimes(3);
      expect(result.ticketsDeleted).toBe(437);
      expect(result.truncated).toBe(false);
    });

    it("reports truncated when the batch cap is reached with rows still eligible", async () => {
      const tx = makeSequencedTx(
        new Array(200).fill(null).map(() => rowsOfSize(200)),
      );
      const result = await service.sweep();
      expect(tx.delete).toHaveBeenCalledTimes(100);
      expect(result.ticketsDeleted).toBe(20_000);
      expect(result.truncated).toBe(true);
    });

    it("records the truncation in the audit row rather than reporting a clean sweep", async () => {
      const tx = makeSequencedTx(
        new Array(200).fill(null).map(() => rowsOfSize(200)),
      );
      await service.sweep();
      expect(getInsertValues(tx)).toHaveBeenCalledWith(
        expect.objectContaining({
          after: expect.objectContaining({ truncated: true, count: 20_000 }),
        }),
      );
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
